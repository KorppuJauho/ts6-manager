package main

import (
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

// The UI splits a profile key into codec and backend on the underscore, and
// recomposes it from the codec dropdown plus the hardware toggle. A key that
// does not have that shape cannot be selected.
func TestProfileKeysAreCodecUnderscoreBackend(t *testing.T) {
	for _, p := range encoderProfiles {
		parts := strings.Split(p.Key, "_")
		if len(parts) != 2 {
			t.Errorf("profile key %q is not <codec>_<backend>", p.Key)
			continue
		}
		wantBackend := "software"
		if p.HWAccel != "" {
			wantBackend = p.HWAccel
		}
		if parts[1] != wantBackend {
			t.Errorf("profile %q: key says backend %q, HWAccel is %q", p.Key, parts[1], p.HWAccel)
		}
	}
}

// A hardware profile falls back to the software profile for the same codec, so
// the two must agree on everything the peer negotiated — otherwise the
// fallback changes the codec under a connected peer.
func TestPayloadTypeAndFmtpAgreePerCodec(t *testing.T) {
	byMime := map[string]EncoderProfile{}
	for _, p := range encoderProfiles {
		first, seen := byMime[p.MimeType]
		if !seen {
			byMime[p.MimeType] = p
			continue
		}
		if p.PayloadType != first.PayloadType {
			t.Errorf("%s: payload type %d != %d on %s", p.Key, p.PayloadType, first.PayloadType, first.Key)
		}
		if p.SDPFmtpLine != first.SDPFmtpLine {
			t.Errorf("%s: fmtp line differs from %s", p.Key, first.Key)
		}
	}
}

// Every H.264 failure this guards against presents identically — a stream that
// negotiates, connects, counts packets, and shows nothing.
func TestH264ProfilesCarryWhatOpenH264Needs(t *testing.T) {
	found := 0
	for _, p := range encoderProfiles {
		if p.MimeType != webrtc.MimeTypeH264 {
			continue
		}
		found++

		// Without parameter sets in the bitstream the decoder never
		// configures itself: pion builds the SDP, so FFmpeg's extradata
		// (which would become sprop-parameter-sets) never reaches the peer.
		if !strings.Contains(strings.Join(p.ExtraArgs, " "), "dump_extra") {
			t.Errorf("%s: no in-band SPS/PPS, the stream will be black", p.Key)
		}

		// OpenH264 implements Constrained Baseline. Main or High negotiates
		// and then fails to decode.
		args := strings.Join(p.ExtraArgs, " ")
		if !strings.Contains(args, "baseline") {
			t.Errorf("%s: encodes a profile OpenH264 cannot decode", p.Key)
		}
		if !strings.Contains(args, "-bf 0") {
			t.Errorf("%s: B-frames are not allowed in Constrained Baseline", p.Key)
		}

		if !strings.Contains(p.SDPFmtpLine, "profile-level-id=42e01f") {
			t.Errorf("%s: fmtp does not advertise Constrained Baseline: %q", p.Key, p.SDPFmtpLine)
		}
		if !strings.Contains(p.SDPFmtpLine, "packetization-mode=1") {
			t.Errorf("%s: fmtp must match FFmpeg's STAP-A/FU-A packetisation: %q", p.Key, p.SDPFmtpLine)
		}
	}

	if found != 2 {
		t.Fatalf("expected a software and a hardware H.264 profile, found %d", found)
	}
}

// VP8 and VP9 negotiate on the codec name. Adding an fmtp line to them would
// change an offer that is known to work.
func TestVpxProfilesCarryNoFmtp(t *testing.T) {
	for _, p := range encoderProfiles {
		if p.MimeType == webrtc.MimeTypeH264 {
			continue
		}
		if p.SDPFmtpLine != "" {
			t.Errorf("%s: unexpected fmtp line %q", p.Key, p.SDPFmtpLine)
		}
	}
}

// Falling back has to find a software profile for the same codec, or a
// hardware failure silently changes which codec the peer gets.
func TestEveryCodecHasASoftwareProfile(t *testing.T) {
	software := map[string]bool{}
	for _, p := range encoderProfiles {
		if p.HWAccel == "" {
			software[p.MimeType] = true
		}
	}
	for _, p := range encoderProfiles {
		if !software[p.MimeType] {
			t.Errorf("%s has no software fallback for %s", p.Key, p.MimeType)
		}
	}
}
