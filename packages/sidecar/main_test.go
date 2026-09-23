package main

import (
	"os"
	"strings"
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

	s.setActiveProfile(mustProfile(t, "vp8_software"), "", 1280, 720, 30)
	if !s.gateKeyframe.Load() {
		t.Fatal("VP8 must gate on a keyframe")
	}

	s.setActiveProfile(mustProfile(t, "vp9_vaapi"), "/dev/dri/renderD128", 1280, 720, 30)
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

// The SDP and the local track are built from one capability, and for H.264 it
// has to describe the size actually being encoded — the level is part of the
// codec's identity, not decoration.
func TestVideoCodecCarriesTheEncodedSize(t *testing.T) {
	s := NewSidecar()

	// Before any source, VP8 negotiates on its name alone.
	if got := s.videoCodec().SDPFmtpLine; got != "" {
		t.Errorf("default profile should need no fmtp, got %q", got)
	}

	s.setActiveProfile(mustProfile(t, "h264_vaapi"), "/dev/dri/renderD128", 1920, 1080, 30)
	cap := s.videoCodec()
	if cap.MimeType != webrtc.MimeTypeH264 {
		t.Fatalf("mime = %q, want H264", cap.MimeType)
	}
	if !strings.Contains(cap.SDPFmtpLine, "profile-level-id=42e028") {
		t.Errorf("1080p must advertise level 4.0, got %q", cap.SDPFmtpLine)
	}

	s.setActiveProfile(mustProfile(t, "h264_vaapi"), "/dev/dri/renderD128", 1280, 720, 30)
	if got := s.videoCodec().SDPFmtpLine; !strings.Contains(got, "profile-level-id=42e01f") {
		t.Errorf("720p must advertise level 3.1, got %q", got)
	}
}

// The offer must be a multi-codec one, because every TeamSpeak stream the
// client is known to render is: a viewer whose hardware cannot decode AV1 is
// moved to H.264 mid-stream with no renegotiation, which only works when both
// payload types were in the m-line from the start.
func TestVideoCodecsOfferEveryCodecActiveFirst(t *testing.T) {
	t.Setenv("SIDECAR_MULTI_CODEC_OFFER", "1")

	s := NewSidecar()
	s.setActiveProfile(mustProfile(t, "h264_vaapi"), "/dev/dri/renderD128", 1280, 720, 30)

	codecs := s.videoCodecs()
	if len(codecs) < 2 {
		t.Fatalf("offer carries %d codec(s), want the alternatives too", len(codecs))
	}

	// The active codec leads: it is the only one that can actually be sent,
	// and it is what the local track binds to.
	if codecs[0].MimeType != webrtc.MimeTypeH264 {
		t.Errorf("first codec = %q, want the active H264", codecs[0].MimeType)
	}
	if codecs[0].SDPFmtpLine != s.videoCodec().SDPFmtpLine {
		t.Errorf("offered fmtp %q disagrees with the track's %q",
			codecs[0].SDPFmtpLine, s.videoCodec().SDPFmtpLine)
	}

	// One entry per codec, not per profile: the hardware and software
	// profiles for a codec share a mime type and a payload type, and
	// registering either twice is a duplicate payload type in the m-line.
	seenMime := map[string]bool{}
	seenPT := map[webrtc.PayloadType]bool{}
	for _, c := range codecs {
		if seenMime[c.MimeType] {
			t.Errorf("codec %q offered twice", c.MimeType)
		}
		if seenPT[c.PayloadType] {
			t.Errorf("payload type %d offered twice", c.PayloadType)
		}
		seenMime[c.MimeType] = true
		seenPT[c.PayloadType] = true
	}

	for _, want := range []string{webrtc.MimeTypeVP8, webrtc.MimeTypeVP9, webrtc.MimeTypeH264} {
		if !seenMime[want] {
			t.Errorf("offer omits %q", want)
		}
	}
}

// An alternative codec still has to be described correctly. H.264 offered
// alongside VP9 needs its fmtp line, or it is advertised as something the
// client cannot match.
func TestAlternativeH264StillCarriesItsFmtp(t *testing.T) {
	t.Setenv("SIDECAR_MULTI_CODEC_OFFER", "1")

	s := NewSidecar()
	s.setActiveProfile(mustProfile(t, "vp9_vaapi"), "/dev/dri/renderD128", 1920, 1080, 30)

	for _, c := range s.videoCodecs() {
		if c.MimeType != webrtc.MimeTypeH264 {
			continue
		}
		if !strings.Contains(c.SDPFmtpLine, "profile-level-id=42e028") {
			t.Errorf("H264 offered as an alternative at 1080p must still say level 4.0, got %q", c.SDPFmtpLine)
		}
		return
	}
	t.Fatal("H264 was not offered alongside VP9")
}

// Off is the default: the multi-codec offer does not help H.264, and a single
// codec is the shape main ships. An unconfigured sidecar must send that.
func TestMultiCodecOfferIsOffByDefault(t *testing.T) {
	s := NewSidecar()
	s.setActiveProfile(mustProfile(t, "vp9_vaapi"), "/dev/dri/renderD128", 1280, 720, 30)

	codecs := s.videoCodecs()
	if len(codecs) != 1 {
		t.Fatalf("offer carries %d codecs with the flag off, want 1", len(codecs))
	}
	if codecs[0].MimeType != webrtc.MimeTypeVP9 {
		t.Errorf("remaining codec = %q, want the active VP9", codecs[0].MimeType)
	}
}

// Every offer an ordinary WebRTC implementation makes carries these, and
// pion's own RegisterDefaultCodecs sets all four. The hand-built media engine
// here set none, so the client had no negotiated way to report loss or ask
// for a keyframe.
func TestVideoCodecsAdvertiseFeedback(t *testing.T) {
	t.Setenv("SIDECAR_MULTI_CODEC_OFFER", "1")

	s := NewSidecar()
	s.setActiveProfile(mustProfile(t, "h264_vaapi"), "/dev/dri/renderD128", 1280, 720, 30)

	want := map[string]bool{"goog-remb": false, "ccm fir": false, "nack": false, "nack pli": false}
	for _, c := range s.videoCodecs() {
		got := map[string]bool{}
		for _, fb := range c.RTCPFeedback {
			name := fb.Type
			if fb.Parameter != "" {
				name += " " + fb.Parameter
			}
			got[name] = true
		}
		for name := range want {
			if !got[name] {
				t.Errorf("codec %q does not advertise %q", c.MimeType, name)
			}
		}
	}

	// The track's capability is built from the same place, so it cannot
	// drift from what is registered.
	if len(s.videoCodec().RTCPFeedback) != len(videoRTCPFeedback) {
		t.Error("the local track's capability disagrees with the registered codec's feedback")
	}
}

func TestEnvBoolOrDefault(t *testing.T) {
	cases := []struct {
		value string
		def   bool
		want  bool
	}{
		{"", true, true},
		{"", false, false},
		{"0", true, false},
		{"false", true, false},
		{"FALSE", true, false},
		{" no ", true, false},
		{"1", false, true},
		{"yes", false, true},
	}
	for _, c := range cases {
		t.Setenv("SIDECAR_TEST_FLAG", c.value)
		if c.value == "" {
			os.Unsetenv("SIDECAR_TEST_FLAG")
		}
		if got := envBoolOrDefault("SIDECAR_TEST_FLAG", c.def); got != c.want {
			t.Errorf("envBoolOrDefault(%q, %v) = %v, want %v", c.value, c.def, got, c.want)
		}
	}
}

// The feedback and the multi-codec offer shipped together, so each has to be
// switchable on its own for either to be isolated on a live deployment.
func TestRTCPFeedbackCanBeSwitchedOff(t *testing.T) {
	t.Setenv("SIDECAR_RTCP_FEEDBACK", "0")

	s := NewSidecar()
	s.setActiveProfile(mustProfile(t, "vp9_vaapi"), "/dev/dri/renderD128", 1280, 720, 30)

	for _, c := range s.videoCodecs() {
		if len(c.RTCPFeedback) != 0 {
			t.Errorf("codec %q still advertises %d feedback entries", c.MimeType, len(c.RTCPFeedback))
		}
	}
}
