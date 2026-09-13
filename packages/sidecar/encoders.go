package main

import (
	"context"
	"fmt"
	"log"
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

	// HWAccel is "" for software encoding, otherwise the FFmpeg hwaccel name
	// ("vaapi"). A profile with a backend needs a device path.
	HWAccel string `json:"hwAccel"`

	// Encoder is the FFmpeg encoder name, and what availability is probed on.
	Encoder string `json:"encoder"`

	// PixelFormat is the format frames are converted to at the end of the
	// filter chain. Hardware profiles upload after this conversion.
	PixelFormat string `json:"-"`

	// ExtraArgs are appended after the rate-control flags.
	ExtraArgs []string `json:"-"`
}

// NeedsDevice reports whether this profile has to be given a DRM render node.
func (p EncoderProfile) NeedsDevice() bool { return p.HWAccel != "" }

// encoderProfiles is the registry. Order is the order the UI lists them in.
//
// Only VP8 and VP9 are listed as usable. H.264 is deliberately absent rather
// than present-and-broken: the RTP depacketiser and the keyframe detection in
// main.go are VP8/VP9 shaped, and offering an H.264 profile that negotiates
// but never renders would be worse than not offering it. See
// docs/fork-changes.md.
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
		HWAccel: "vaapi", Encoder: "vp8_vaapi", PixelFormat: "nv12",
	},
	{
		Key: "vp9_vaapi", Label: "VP9 (VAAPI hardware)",
		MimeType: webrtc.MimeTypeVP9, PayloadType: 98,
		HWAccel: "vaapi", Encoder: "vp9_vaapi", PixelFormat: "nv12",
		ExtraArgs: []string{"-strict", "experimental"},
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
			// Treat an unprobeable FFmpeg as "software only" rather than
			// failing: the software profiles are always compiled in.
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
	args = append(args, p.ExtraArgs...)
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
		return defaultProfile(), fmt.Sprintf("unknown encoder profile %q, using %s", key, defaultProfileKey)
	}
	if probeEncoder(p, device) {
		return p, ""
	}

	// Prefer the software encoder for the same codec, so the negotiated codec
	// does not change underneath a peer that has already connected.
	for _, alt := range encoderProfiles {
		if alt.MimeType == p.MimeType && alt.HWAccel == "" && probeEncoder(alt, device) {
			return alt, fmt.Sprintf("encoder %q cannot run on this host, falling back to %s", p.Encoder, alt.Key)
		}
	}
	return defaultProfile(), fmt.Sprintf("encoder %q cannot run on this host, falling back to %s", p.Encoder, defaultProfileKey)
}
