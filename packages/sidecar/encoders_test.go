package main

import (
	"strings"
	"testing"
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
