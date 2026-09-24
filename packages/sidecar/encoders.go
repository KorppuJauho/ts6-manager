package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

// EncoderProfile is one way of producing the video track: a codec, an
// optional hardware backend, and the FFmpeg arguments that go with them.
//
// The codec is not free to vary on its own. Whatever is chosen here has to
// appear identically in the SDP the peer negotiates (RegisterCodec), in the
// local track's capability, and in FFmpeg's -payload_type — so all three are
// derived from this one record rather than written out separately.
type EncoderProfile struct {
	Key   string `json:"key"`
	Label string `json:"label"`

	// Codec identity, shared by SDP, the local track and the RTP packets.
	MimeType    string `json:"mimeType"`
	PayloadType uint8  `json:"payloadType"`

	// NeedsFmtp marks a codec whose "a=fmtp" parameters are part of what the
	// peer agrees to. VP8 and VP9 negotiate on the codec name alone; H.264
	// does not, and the line it needs depends on the resolution being sent,
	// so it is built per stream by FmtpFor rather than stored here.
	NeedsFmtp bool `json:"needsFmtp,omitempty"`

	// HWAccel is "" for software encoding, otherwise the hardware backend:
	// "vaapi" (Intel, AMD) or "nvenc" (NVIDIA). It is also the second half of
	// the profile key, which is how the settings compose codec and backend.
	HWAccel string `json:"hwAccel"`

	// DecodeHWAccel is the -hwaccel that decodes the source on the same GPU,
	// or "" to decode on the CPU. It is not HWAccel: NVIDIA's encoder is
	// NVENC, but its decoder is reached through FFmpeg's "cuda" hwaccel.
	DecodeHWAccel string `json:"-"`

	// Encoder is the FFmpeg encoder name, and what availability is probed on.
	Encoder string `json:"encoder"`

	// PixelFormat is the format frames are converted to at the end of the
	// filter chain. Hardware profiles upload after this conversion.
	PixelFormat string `json:"-"`

	// ExtraArgs are appended after the rate-control flags.
	ExtraArgs []string `json:"-"`
}

// NeedsDevice reports whether this profile has to be given a DRM render node.
//
// Only VAAPI does. NVENC opens the GPU through the CUDA driver, and which GPU
// that is gets decided by the container runtime (NVIDIA_VISIBLE_DEVICES), so
// inside the container it is always the first one.
func (p EncoderProfile) NeedsDevice() bool { return p.HWAccel == "vaapi" }

// h264Level is one row of Table A-1: the level_idc byte, the largest frame it
// allows in macroblocks, and the macroblocks per second it can sustain.
type h264Level struct {
	idc     uint8
	maxFS   int
	maxMBPS int
}

// Ascending, so the first row a stream fits in is the lowest level that can
// carry it. 4.1 is omitted: it has the same frame and rate limits as 4.0 and
// differs only in bitrate and buffer size, so it can never be the first fit.
var h264Levels = []h264Level{
	{idc: 0x1e, maxFS: 1620, maxMBPS: 40500},    // 3.0
	{idc: 0x1f, maxFS: 3600, maxMBPS: 108000},   // 3.1  - 720p30 exactly
	{idc: 0x20, maxFS: 5120, maxMBPS: 216000},   // 3.2
	{idc: 0x28, maxFS: 8192, maxMBPS: 245760},   // 4.0  - 1080p30 exactly
	{idc: 0x2a, maxFS: 8704, maxMBPS: 522240},   // 4.2
	{idc: 0x32, maxFS: 22080, maxMBPS: 589824},  // 5.0  - 1440p30
	{idc: 0x33, maxFS: 36864, maxMBPS: 983040},  // 5.1  - 2160p30
	{idc: 0x34, maxFS: 36864, maxMBPS: 2073600}, // 5.2
}

// h264LevelIdc returns the lowest level that can actually carry this stream.
//
// A hardcoded level 3.1, which caps at 1280x720, was once advertised while
// h264_vaapi stamped level 4.0 into the SPS of a 1080p stream: the SDP
// promising less than the stream carries. That turned out not to be what made
// H.264 render black — the profile was — but a decoder is entitled to size
// itself from the advertised level, so it has to cover the stream.
func h264LevelIdc(width, height, fps int) uint8 {
	if width <= 0 || height <= 0 {
		return h264Levels[len(h264Levels)-1].idc
	}
	if fps <= 0 {
		fps = 30
	}

	// A macroblock is 16x16, and a partial one still counts.
	mbs := ((width + 15) / 16) * ((height + 15) / 16)
	for _, l := range h264Levels {
		if mbs <= l.maxFS && mbs*fps <= l.maxMBPS {
			return l.idc
		}
	}
	return h264Levels[len(h264Levels)-1].idc
}

// h264FmtpLine builds the "a=fmtp" parameters for a stream of this size.
//
// The first four hex digits of profile-level-id come from the selected H.264
// profile (see h264Profile), so the SDP always names the profile the encoder
// is actually asked for. Only the level byte is computed here.
//
// packetization-mode=1 is what FFmpeg's RTP muxer emits (STAP-A and FU-A).
func h264FmtpLine(width, height, fps int) string {
	return fmt.Sprintf(
		"level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=%s%02x",
		selectedH264Profile().profileIOP, h264LevelIdc(width, height, fps),
	)
}

// FmtpFor returns the fmtp line this profile needs for a stream of this size,
// or "" for a codec that negotiates on its name alone.
func (p EncoderProfile) FmtpFor(width, height, fps int) string {
	if !p.NeedsFmtp {
		return ""
	}
	return h264FmtpLine(width, height, fps)
}

// h264Profile is one H.264 profile the sidecar can send. What the SDP
// advertises and what each encoder is asked for live in one record, because
// the two must agree: a profile-level-id naming one profile over a stream
// encoded in another is exactly the kind of mismatch that negotiates, connects
// and shows nothing.
type h264Profile struct {
	// name is the SIDECAR_H264_PROFILE value.
	name string
	// profileIOP is profile_idc and the constraint flags: the first four hex
	// digits of profile-level-id, spelled the way libwebrtc spells them.
	profileIOP string
	// vaapi, nvenc and x264 are the -profile:v values each encoder knows it
	// by.
	vaapi string
	nvenc string
	x264  string
}

// h264Profiles lists what can be selected; the first entry is the default.
//
// Constrained High is the default because it is the only H.264 profile the
// TeamSpeak client decodes. Its own stream offer lists H.264 solely as
// profile-level-id=640c1f, and offered 640c from here it builds
// FFmpeg (h264_cuvid) and renders. Everything else fails, each in its own way:
// Main and High are rejected with a port-0 video m-line, and Constrained
// Baseline is accepted in the answer and then given NullVideoDecoder —
// libwebrtc's placeholder for a format the application's decoder factory
// returns nothing for — so it connects, counts packets and shows black. The
// others stay selectable because that is how this was established.
//
// libwebrtc treats High (6400) and Constrained High (640c) as different
// profiles when it matches an offer against what the receiver supports, which
// is why the constraint flags matter even though neither encoder has a
// Constrained High spelling of its own. They encode High, and every profile
// encodes with B-frames off and progressive frames, which is what Constrained
// High requires — so the advertisement is truthful, and the constraint flags
// in the in-band SPS staying 00 does not matter: the decoder is chosen from
// the SDP.
var h264Profiles = []h264Profile{
	{name: "constrained_high", profileIOP: "640c", vaapi: "high", nvenc: "high", x264: "high"},
	{name: "constrained_baseline", profileIOP: "42e0", vaapi: "constrained_baseline", nvenc: "baseline", x264: "baseline"},
	{name: "main", profileIOP: "4d00", vaapi: "main", nvenc: "main", x264: "main"},
	{name: "high", profileIOP: "6400", vaapi: "high", nvenc: "high", x264: "high"},
}

// selectedH264Profile is the profile SIDECAR_H264_PROFILE names, or the
// default when it is unset or names nothing known. Env is fixed at container
// start, so this is constant for the life of the process.
func selectedH264Profile() h264Profile {
	want := strings.ToLower(strings.TrimSpace(os.Getenv("SIDECAR_H264_PROFILE")))
	for _, p := range h264Profiles {
		if p.name == want {
			return p
		}
	}
	return h264Profiles[0]
}

// encodeArgs is ExtraArgs plus, for H.264, the -profile:v the selected profile
// calls for. Both the stream and the encoder probe use it, so a GPU without an
// entrypoint for the chosen profile fails the probe and falls back rather
// than failing at stream start.
func (p EncoderProfile) encodeArgs() []string {
	if p.MimeType != webrtc.MimeTypeH264 {
		return p.ExtraArgs
	}
	hp := selectedH264Profile()
	name := hp.x264
	switch p.Encoder {
	case "h264_vaapi":
		name = hp.vaapi
	case "h264_nvenc":
		name = hp.nvenc
	}
	return append([]string{"-profile:v", name}, p.ExtraArgs...)
}

// h264InBandParameterSets re-inserts SPS/PPS ahead of every keyframe.
//
// FFmpeg hands the parameter sets to the muxer as extradata, where an SDP the
// muxer generates itself would carry them as sprop-parameter-sets. We build
// the SDP in pion instead and never see that extradata, so the bitstream is
// the only place a decoder can get them from — and a viewer who joins
// mid-stream needs them again at the next keyframe, not just once at the start.
//
// Harmless when redundant: the filter compares against the packet it is about
// to prepend to and skips if the parameter sets are already there.
var h264InBandParameterSets = []string{"-bsf:v", "dump_extra=freq=keyframe"}

// encoderProfiles is the registry. Order is the order the UI lists them in.
var encoderProfiles = []EncoderProfile{
	{
		Key: "vp8_software", Label: "VP8 (software)",
		MimeType: webrtc.MimeTypeVP8, PayloadType: 96,
		Encoder: "libvpx", PixelFormat: "yuv420p",
		ExtraArgs: []string{
			"-cpu-used", "6", "-deadline", "realtime",
			"-lag-in-frames", "0", "-error-resilient", "1",
			"-keyint_min", "15", "-auto-alt-ref", "0",
		},
	},
	{
		Key: "vp9_software", Label: "VP9 (software)",
		MimeType: webrtc.MimeTypeVP9, PayloadType: 98,
		Encoder: "libvpx-vp9", PixelFormat: "yuv420p",
		ExtraArgs: []string{
			"-cpu-used", "8", "-deadline", "realtime",
			"-lag-in-frames", "0", "-error-resilient", "1",
			"-row-mt", "1", "-auto-alt-ref", "0",
			// VP9-in-RTP is still gated behind -strict experimental.
			"-strict", "experimental",
		},
	},
	{
		Key: "vp8_vaapi", Label: "VP8 (VAAPI hardware)",
		MimeType: webrtc.MimeTypeVP8, PayloadType: 96,
		HWAccel: "vaapi", DecodeHWAccel: "vaapi", Encoder: "vp8_vaapi", PixelFormat: "nv12",
	},
	{
		Key: "vp9_vaapi", Label: "VP9 (VAAPI hardware)",
		MimeType: webrtc.MimeTypeVP9, PayloadType: 98,
		HWAccel: "vaapi", DecodeHWAccel: "vaapi", Encoder: "vp9_vaapi", PixelFormat: "nv12",
		ExtraArgs: []string{"-strict", "experimental"},
	},
	{
		Key: "h264_software", Label: "H.264 (software)",
		MimeType: webrtc.MimeTypeH264, PayloadType: 102,
		NeedsFmtp: true,
		Encoder:   "libx264", PixelFormat: "yuv420p",
		// -profile:v comes from encodeArgs, from the same record as the SDP.
		// B-frames stay off for every profile: they add a frame of latency
		// and reorder output, which a real-time receiver has no use for.
		ExtraArgs: append([]string{
			"-preset", "veryfast",
			"-tune", "zerolatency",
			"-bf", "0",
		}, h264InBandParameterSets...),
	},
	{
		Key: "h264_vaapi", Label: "H.264 (VAAPI hardware)",
		MimeType: webrtc.MimeTypeH264, PayloadType: 102,
		NeedsFmtp: true,
		HWAccel:   "vaapi", DecodeHWAccel: "vaapi", Encoder: "h264_vaapi", PixelFormat: "nv12",
		// -profile:v comes from encodeArgs. A driver with no encode
		// entrypoint for the selected profile fails the probe and falls back
		// to libx264, which can encode all three.
		ExtraArgs: append([]string{
			"-bf", "0",
		}, h264InBandParameterSets...),
	},
	{
		// NVIDIA has no VP8 or VP9 encoder, so H.264 is its only profile —
		// which is also the codec the TeamSpeak client decodes on its GPU.
		Key: "h264_nvenc", Label: "H.264 (NVIDIA NVENC)",
		MimeType: webrtc.MimeTypeH264, PayloadType: 102,
		NeedsFmtp: true,
		HWAccel:   "nvenc", DecodeHWAccel: "cuda", Encoder: "h264_nvenc",
		// NVENC takes frames from system memory and uploads them itself, so
		// unlike VAAPI there is no hwupload. The 4:2:0 format is not optional:
		// handed RGB, h264_nvenc switches to High 4:4:4 Predictive and ignores
		// -profile:v, which is a profile the TeamSpeak client cannot decode.
		PixelFormat: "nv12",
		// p4 with the low-latency tune is NVENC's balanced real-time setting;
		// zerolatency drops the frame of reordering delay it would otherwise
		// keep. -profile:v comes from encodeArgs.
		ExtraArgs: append([]string{
			"-preset", "p4",
			"-tune", "ll",
			"-rc", "cbr",
			"-zerolatency", "1",
			"-bf", "0",
		}, h264InBandParameterSets...),
	},
}

// defaultProfileKey is what a stream uses when none is requested.
const defaultProfileKey = "vp8_software"

func profileByKey(key string) (EncoderProfile, bool) {
	for _, p := range encoderProfiles {
		if p.Key == key {
			return p, true
		}
	}
	return EncoderProfile{}, false
}

func defaultProfile() EncoderProfile {
	p, _ := profileByKey(defaultProfileKey)
	return p
}

var (
	availableOnce sync.Once
	availableSet  map[string]bool
)

// availableEncoders lists the encoder names this FFmpeg build was compiled
// with. Necessary but not sufficient: a build can offer vp8_vaapi while the
// GPU has no VP8 encode entrypoint, which is why probeEncoder exists.
func availableEncoders() map[string]bool {
	availableOnce.Do(func() {
		availableSet = map[string]bool{}
		out, err := exec.Command(getFfmpegPath(), "-hide_banner", "-encoders").Output()
		if err != nil {
			// Treat an unprobeable FFmpeg as "VP8/VP9 software only" rather
			// than failing: libvpx is in every build worth deploying.
			// libx264 is not assumed — it is a GPL build option, and
			// claiming it is present would offer a profile that fails at
			// stream start instead of one the UI shows as unavailable.
			availableSet["libvpx"] = true
			availableSet["libvpx-vp9"] = true
			return
		}
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			// Encoder lines look like: " V....D vp9_vaapi   VP9 (VAAPI)"
			if len(fields) >= 2 && strings.HasPrefix(fields[0], "V") {
				availableSet[fields[1]] = true
			}
		}
	})
	return availableSet
}

type probeKey struct{ encoder, device string }

var probeCache sync.Map // probeKey -> bool

// probeEncoder answers whether this host can actually encode with a profile,
// by encoding a handful of frames with it and seeing whether FFmpeg succeeds.
//
// Asking `ffmpeg -encoders` is not enough, and the difference is not academic:
// a build that ships vp8_vaapi on a GPU whose VAAPI driver exposes no VP8
// encode entrypoint reports the encoder as present, offers it in the UI, and
// then fails at stream start with "No usable encoding entrypoint found". Only
// running it distinguishes the two.
//
// Results are cached per encoder and device: the answer cannot change while
// the process runs, and a probe costs an FFmpeg launch.
func probeEncoder(p EncoderProfile, device string) bool {
	if !availableEncoders()[p.Encoder] {
		return false
	}
	if p.NeedsDevice() && device == "" {
		return false
	}
	// A profile that takes no device ignores it, so the answer must not be
	// cached — and the probe rerun — once per device the caller happens to
	// pass.
	if !p.NeedsDevice() {
		device = ""
	}

	key := probeKey{encoder: p.Encoder, device: device}
	if cached, ok := probeCache.Load(key); ok {
		return cached.(bool)
	}

	ok := runEncoderProbe(p, device)
	probeCache.Store(key, ok)
	if !ok {
		log.Printf("[Probe] %s unusable on this host", p.Key)
	}
	return ok
}

func runEncoderProbe(p EncoderProfile, device string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	args := []string{"-hide_banner", "-loglevel", "error"}
	if p.NeedsDevice() {
		args = append(args, "-vaapi_device", device)
	}

	hwUpload := ""
	if p.NeedsDevice() {
		hwUpload = ",hwupload"
	}

	// A few frames at a small size: enough to force encoder initialisation,
	// which is where an unsupported profile fails, without costing real time.
	args = append(args,
		"-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=0.2",
		"-vf", fmt.Sprintf("format=%s%s", p.PixelFormat, hwUpload),
		"-c:v", p.Encoder,
		"-b:v", "500k",
	)
	args = append(args, p.encodeArgs()...)
	args = append(args, "-f", "null", "-")

	return exec.CommandContext(ctx, getFfmpegPath(), args...).Run() == nil
}

// ProfileStatus is one entry of the /capabilities response.
type ProfileStatus struct {
	EncoderProfile
	Available bool `json:"available"`
}

// encoderCapabilities reports what this host can actually encode with.
// `device` is the render node hardware profiles are probed against; without
// one they are reported unavailable, since they cannot run anyway.
func encoderCapabilities(device string) []ProfileStatus {
	out := make([]ProfileStatus, 0, len(encoderProfiles))
	for _, p := range encoderProfiles {
		out = append(out, ProfileStatus{EncoderProfile: p, Available: probeEncoder(p, device)})
	}
	return out
}

// resolveProfile picks the profile to encode with, falling back when the
// requested one cannot run here.
//
// Falling back rather than failing is deliberate: hardware encoding depends on
// a GPU being present, passed through, and permitted to the container user,
// and none of that is visible from the settings screen. A stream that quietly
// runs in software is a better outcome than one that refuses to start, so long
// as the reason is logged — which is why the caller is told what happened.
func resolveProfile(key string, device string) (EncoderProfile, string) {
	if key == "" {
		return defaultProfile(), ""
	}
	p, ok := profileByKey(key)
	if !ok {
		// A codec the chosen backend has no encoder for — VP9 with NVENC —
		// composes a key nothing registers. Keep the codec and drop the
		// backend: answering with the default instead would quietly swap VP9
		// for VP8 as well as the GPU for the CPU.
		codec, _, _ := strings.Cut(key, "_")
		if alt, ok := profileByKey(codec + "_software"); ok && canEncode(alt, device) {
			return alt, fmt.Sprintf("no encoder profile %q, using %s", key, alt.Key)
		}
		return defaultProfile(), fmt.Sprintf("unknown encoder profile %q, using %s", key, defaultProfileKey)
	}
	if canEncode(p, device) {
		return p, ""
	}

	// Prefer the software encoder for the same codec, so the negotiated codec
	// does not change underneath a peer that has already connected.
	for _, alt := range encoderProfiles {
		if alt.MimeType == p.MimeType && alt.HWAccel == "" && canEncode(alt, device) {
			return alt, fmt.Sprintf("encoder %q cannot run on this host, falling back to %s", p.Encoder, alt.Key)
		}
	}
	return defaultProfile(), fmt.Sprintf("encoder %q cannot run on this host, falling back to %s", p.Encoder, defaultProfileKey)
}

// canEncode is probeEncoder, replaceable in tests: a probe runs FFmpeg, and
// the fallback order should be testable on a machine without it.
var canEncode = probeEncoder
