package main

import (
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
	if !strings.Contains(cap.SDPFmtpLine, "profile-level-id=640c28") {
		t.Errorf("1080p must advertise level 4.0, got %q", cap.SDPFmtpLine)
	}

	s.setActiveProfile(mustProfile(t, "h264_vaapi"), "/dev/dri/renderD128", 1280, 720, 30)
	if got := s.videoCodec().SDPFmtpLine; !strings.Contains(got, "profile-level-id=640c1f") {
		t.Errorf("720p must advertise level 3.1, got %q", got)
	}
}

// -hwaccel is an input option: it binds to the -i that follows it, so it must
// sit in front of the video input and nowhere else.
func TestInputArgsDecodeVideoOnTheGPU(t *testing.T) {
	video, audio := "https://example.test/v.m3u8", "https://example.test/a.webm"

	got := strings.Join(inputArgs([]string{video, audio}, "vaapi", ""), " ")
	if !strings.Contains(got, "-hwaccel vaapi -i "+video) {
		t.Errorf("DASH video input is not GPU-decoded: %q", got)
	}
	if strings.Contains(got, "-hwaccel vaapi -i "+audio) || strings.Count(got, "-hwaccel ") != 1 {
		t.Errorf("-hwaccel must apply to the video input only: %q", got)
	}

	// A progressive source carries video and audio in the one input.
	if got := strings.Join(inputArgs([]string{video}, "vaapi", ""), " "); !strings.Contains(got, "-hwaccel vaapi -i "+video) {
		t.Errorf("progressive input is not GPU-decoded: %q", got)
	}
}

// Input options bind to the next -i only. A DASH pair's audio is its own
// connection: without its own reconnect options, the first reset YouTube sent
// ended the audio while the video played on.
func TestInputArgsGiveEachInputItsOwnOptions(t *testing.T) {
	got := inputArgs([]string{"https://example.test/v.m3u8", "https://example.test/a.webm"}, "", "")
	want := []string{
		"-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
		"-fflags", "+genpts+discardcorrupt", "-re",
		"-i", "https://example.test/v.m3u8",
		"-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
		"-fflags", "+genpts+discardcorrupt", "-re",
		"-i", "https://example.test/a.webm",
	}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("got  %q\nwant %q", got, want)
	}

	// A local file loops instead of reconnecting.
	if got := strings.Join(inputArgs([]string{"/media/clip.mp4"}, "", ""), " "); !strings.HasPrefix(got, "-stream_loop -1 ") {
		t.Errorf("local file should loop: %q", got)
	}
}

// Each backend decodes through its own hwaccel, which for NVIDIA is not named
// after its encoder. VAAPI needs its render node to decode at all; NVENC
// needs none, and software profiles never touch a GPU.
func TestDecodeHWAccelFollowsTheEncodingGPU(t *testing.T) {
	for _, c := range []struct {
		key, device, want string
	}{
		{"h264_vaapi", "/dev/dri/renderD128", "vaapi"},
		{"vp9_vaapi", "/dev/dri/renderD128", "vaapi"},
		{"h264_vaapi", "", ""},
		{"h264_nvenc", "", "cuda"},
		{"h264_software", "/dev/dri/renderD128", ""},
	} {
		if got := decodeHWAccel(mustProfile(t, c.key), c.device); got != c.want {
			t.Errorf("%s with device %q: got %q, want %q", c.key, c.device, got, c.want)
		}
	}

	t.Setenv("SIDECAR_HW_DECODE", "0")
	if got := decodeHWAccel(mustProfile(t, "h264_nvenc"), ""); got != "" {
		t.Errorf("SIDECAR_HW_DECODE=0 must decode on the CPU, got %q", got)
	}
}

func TestInputArgsDecodeWithCUDA(t *testing.T) {
	video, audio := "https://example.test/v.m3u8", "https://example.test/a.webm"
	got := strings.Join(inputArgs([]string{video, audio}, "cuda", ""), " ")
	if !strings.Contains(got, "-hwaccel cuda -i "+video) || strings.Count(got, "-hwaccel") != 1 {
		t.Errorf("CUDA must decode the video input only: %q", got)
	}
}

func TestEnvBoolOrDefault(t *testing.T) {
	for _, c := range []struct {
		value string
		def   bool
		want  bool
	}{
		{"", true, true}, {"", false, false},
		{"0", true, false}, {"false", true, false}, {" NO ", true, false},
		{"1", false, true}, {"yes", false, true},
	} {
		t.Setenv("SIDECAR_TEST_FLAG", c.value)
		if got := envBoolOrDefault("SIDECAR_TEST_FLAG", c.def); got != c.want {
			t.Errorf("envBoolOrDefault(%q, %v) = %v, want %v", c.value, c.def, got, c.want)
		}
	}
}

// With VAAPI decoding, the decoded frames stay on the GPU: the input asks for
// VAAPI surfaces and the filters scale them there, with no copy back.
func TestVAAPIFramesStayOnTheGPU(t *testing.T) {
	video, audio := "https://example.test/v.webm", "https://example.test/a.webm"
	got := strings.Join(inputArgs([]string{video, audio}, "vaapi", ""), " ")
	if !strings.Contains(got, "-hwaccel_output_format vaapi -hwaccel vaapi -i "+video) {
		t.Errorf("the video input must keep its frames on the GPU: %q", got)
	}
	if strings.Count(got, "-hwaccel_output_format") != 1 {
		t.Errorf("only the video input decodes on the GPU: %q", got)
	}

	vf := gpuVideoFilter(30, 1920, 1080)
	for _, want := range []string{"fps=30", "format=nv12|vaapi,hwupload", "scale_vaapi=w=1920:h=1080", "force_original_aspect_ratio=decrease", "format=nv12"} {
		if !strings.Contains(vf, want) {
			t.Errorf("GPU filter chain lacks %q: %s", want, vf)
		}
	}
	// Nothing in it may need CPU frames: those filters would force the copy
	// back this chain exists to avoid.
	for _, cpuOnly := range []string{"scale=", "pad="} {
		if strings.Contains(strings.ReplaceAll(vf, "scale_vaapi=", ""), cpuOnly) {
			t.Errorf("GPU filter chain has the CPU filter %q: %s", cpuOnly, vf)
		}
	}
}

// CUDA decoding keeps copying back (measured: no gain on an NVENC host), and
// SIDECAR_GPU_FILTERS=0 turns the VAAPI chain off.
func TestFramesStayOnTheGPUOnlyForVAAPI(t *testing.T) {
	if !framesStayOnGPU("vaapi") {
		t.Error("VAAPI decoding should keep its frames on the GPU")
	}
	for _, hw := range []string{"cuda", ""} {
		if framesStayOnGPU(hw) {
			t.Errorf("hwaccel %q should not keep frames on the GPU", hw)
		}
	}
	if got := strings.Join(inputArgs([]string{"https://example.test/v.webm"}, "cuda", ""), " "); strings.Contains(got, "hwaccel_output_format") {
		t.Errorf("CUDA frames must come back for the CPU filters: %q", got)
	}

	t.Setenv("SIDECAR_GPU_FILTERS", "0")
	if framesStayOnGPU("vaapi") {
		t.Error("SIDECAR_GPU_FILTERS=0 must copy the frames back")
	}
	if got := strings.Join(inputArgs([]string{"https://example.test/v.webm"}, "vaapi", ""), " "); strings.Contains(got, "hwaccel_output_format") {
		t.Errorf("SIDECAR_GPU_FILTERS=0 must not ask for GPU frames: %q", got)
	}
}
