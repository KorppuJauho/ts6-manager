package main

import (
	"fmt"
	"os/exec"
	"strings"
	"sync"

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

// availableEncoders lists the encoder names this FFmpeg build can use, so the
// UI can distinguish a profile the host supports from one it merely knows
// about. Probed once: the answer cannot change while the process runs.
//
// This reports what FFmpeg was *built* with. It cannot tell whether the GPU is
// actually reachable — that needs a device, which is why a stream that fails
// to start on a hardware profile falls back rather than trusting this.
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

// ProfileStatus is one entry of the /capabilities response.
type ProfileStatus struct {
	EncoderProfile
	Available bool `json:"available"`
}

func encoderCapabilities() []ProfileStatus {
	avail := availableEncoders()
	out := make([]ProfileStatus, 0, len(encoderProfiles))
	for _, p := range encoderProfiles {
		out = append(out, ProfileStatus{EncoderProfile: p, Available: avail[p.Encoder]})
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
func resolveProfile(key string) (EncoderProfile, string) {
	if key == "" {
		return defaultProfile(), ""
	}
	p, ok := profileByKey(key)
	if !ok {
		return defaultProfile(), fmt.Sprintf("unknown encoder profile %q, using %s", key, defaultProfileKey)
	}
	if availableEncoders()[p.Encoder] {
		return p, ""
	}

	// Prefer the software encoder for the same codec, so the negotiated
	// codec does not change underneath a peer that has already connected.
	for _, alt := range encoderProfiles {
		if alt.MimeType == p.MimeType && alt.HWAccel == "" && availableEncoders()[alt.Encoder] {
			return alt, fmt.Sprintf("encoder %q unavailable, falling back to %s", p.Encoder, alt.Key)
		}
	}
	return defaultProfile(), fmt.Sprintf("encoder %q unavailable, falling back to %s", p.Encoder, defaultProfileKey)
}
