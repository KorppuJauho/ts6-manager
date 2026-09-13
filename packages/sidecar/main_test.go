package main

import (
	"testing"

	"github.com/pion/webrtc/v4"
)

// A VP9 payload descriptor as FFmpeg's RTP muxer emits it: the first octet
// carries the I/P/L/F/B/E/V flags, never a VP8 descriptor. Fed to the VP8
// parser it must not be mistaken for a decodable start — which is why the
// gate has to be chosen from the profile actually in force.
func TestIsVP8KeyframeStartRejectsVP9Descriptor(t *testing.T) {
	for _, first := range []byte{
		0x0C, // B|E — a whole frame in one packet
		0x08, // B   — first fragment of a frame
		0x1C, // F|B|E — flexible mode
		0x8C, // I|B|E — picture ID present
	} {
		vp9 := []byte{first, 0x82, 0x49, 0x83, 0x42, 0x00}
		if isVP8KeyframeStart(vp9) {
			t.Errorf("VP8 parser accepted VP9 descriptor 0x%02X", first)
		}
	}
}

func TestNeedsKeyframeGate(t *testing.T) {
	for _, tc := range []struct {
		key  string
		want bool
	}{
		{"vp8_software", true},
		{"vp8_vaapi", true},
		{"vp9_software", false},
		{"vp9_vaapi", false},
		// H.264 has no parameter-set detector here either, so it opens on the
		// first packet and relies on the PLI interceptor plus the in-band
		// SPS/PPS repeated at every keyframe.
		{"h264_software", false},
		{"h264_vaapi", false},
	} {
		p, ok := profileByKey(tc.key)
		if !ok {
			t.Fatalf("unknown profile %q", tc.key)
		}
		if got := needsKeyframeGate(p); got != tc.want {
			t.Errorf("needsKeyframeGate(%s) = %v, want %v", tc.key, got, tc.want)
		}
	}
}

// The forwarding goroutines start before any source is set, so the gate flag
// must follow setActiveProfile rather than whatever the default profile was.
func TestGateFlagFollowsActiveProfile(t *testing.T) {
	s := NewSidecar()

	if s.gateKeyframe.Load() {
		t.Fatal("gate must be open before a profile is chosen")
	}

	s.setActiveProfile(mustProfile(t, "vp8_software"), "")
	if !s.gateKeyframe.Load() {
		t.Fatal("VP8 must gate on a keyframe")
	}

	s.setActiveProfile(mustProfile(t, "vp9_vaapi"), "/dev/dri/renderD128")
	if s.gateKeyframe.Load() {
		t.Fatal("VP9 must not be gated by the VP8 parser — this is what showed black video")
	}

	if mt := s.activeProfile().MimeType; mt != webrtc.MimeTypeVP9 {
		t.Fatalf("active profile mime = %q, want VP9", mt)
	}
}

func mustProfile(t *testing.T, key string) EncoderProfile {
	t.Helper()
	p, ok := profileByKey(key)
	if !ok {
		t.Fatalf("unknown profile %q", key)
	}
	return p
}
