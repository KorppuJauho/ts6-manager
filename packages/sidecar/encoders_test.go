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
		if p.NeedsFmtp != first.NeedsFmtp {
			t.Errorf("%s: fmtp requirement differs from %s", p.Key, first.Key)
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

		fmtp := p.FmtpFor(1920, 1080, 30)
		if !strings.Contains(fmtp, "profile-level-id=42e0") {
			t.Errorf("%s: fmtp does not advertise Constrained Baseline: %q", p.Key, fmtp)
		}
		if !strings.Contains(fmtp, "packetization-mode=1") {
			t.Errorf("%s: fmtp must match FFmpeg's STAP-A/FU-A packetisation: %q", p.Key, fmtp)
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
		if got := p.FmtpFor(1920, 1080, 30); got != "" {
			t.Errorf("%s: unexpected fmtp line %q", p.Key, got)
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

// The level advertised in the SDP has to cover the stream actually sent. A
// hardcoded 42e01f (level 3.1, which caps at 1280x720) was offered while
// h264_vaapi stamped level 4.0 into the SPS of a 1080p stream; the peer
// connected, received packets and rendered nothing.
func TestH264LevelCoversEveryPreset(t *testing.T) {
	for _, tc := range []struct {
		name          string
		w, h, fps     int
		wantLevelByte string
	}{
		{"480p24", 854, 480, 24, "1e"},    // 3.0
		{"720p30", 1280, 720, 30, "1f"},   // 3.1, exactly at the limit
		{"1080p30", 1920, 1080, 30, "28"}, // 4.0, what the GPU stamped
		{"1440p30", 2560, 1440, 30, "32"}, // 5.0
		{"2160p30", 3840, 2160, 30, "33"}, // 5.1
	} {
		got := h264FmtpLine(tc.w, tc.h, tc.fps)
		want := "profile-level-id=42e0" + tc.wantLevelByte
		if !strings.Contains(got, want) {
			t.Errorf("%s: got %q, want it to contain %q", tc.name, got, want)
		}
	}
}

// 720p at 60 needs more macroblocks per second than level 3.1 sustains, even
// though the frame itself fits — the rate limit has to bind too, or a high
// frame rate silently under-advertises again.
func TestH264LevelRespectsFrameRate(t *testing.T) {
	at30 := h264LevelIdc(1280, 720, 30)
	at60 := h264LevelIdc(1280, 720, 60)
	if at60 <= at30 {
		t.Errorf("720p60 level 0x%02x should exceed 720p30 level 0x%02x", at60, at30)
	}
}

// An unknown size must over-advertise rather than under-advertise: too low a
// level is what breaks decoding.
func TestH264LevelWithoutDimensions(t *testing.T) {
	if got := h264LevelIdc(0, 0, 0); got != 0x34 {
		t.Errorf("got 0x%02x, want the highest level 0x34", got)
	}
}
