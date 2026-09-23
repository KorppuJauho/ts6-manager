package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// A real SPS and PPS, as libx264 emits them for 1280x720 Constrained
// Baseline — the same pair FFmpeg's own SDP advertised in the oracle run.
var (
	testSPS, _ = base64.StdEncoding.DecodeString("Z0LAH9kAUAW7ARAAAAMAEAAAAwPA8YMkgA==")
	testPPS, _ = base64.StdEncoding.DecodeString("aMuDyyA=")
	testSprop  = "Z0LAH9kAUAW7ARAAAAMAEAAAAwPA8YMkgA==,aMuDyyA="
)

// settled waits out paramSetSettle after a reset, so an observation in a test
// is treated as the new encode's rather than a leftover of the old one.
func settled() { time.Sleep(paramSetSettle + 20*time.Millisecond) }

func stapA(nals ...[]byte) []byte {
	out := []byte{0x18} // F=0, NRI=0, type 24
	for _, n := range nals {
		out = append(out, byte(len(n)>>8), byte(len(n)))
		out = append(out, n...)
	}
	return out
}

func TestParamSetsFromSingleNALPackets(t *testing.T) {
	var p h264ParamSets
	p.observe(testSPS)
	if got := p.sprop(); got != "" {
		t.Fatalf("SPS alone must not produce a sprop, got %q", got)
	}
	p.observe(testPPS)
	if got := p.sprop(); got != testSprop {
		t.Fatalf("sprop = %q, want %q", got, testSprop)
	}
}

// FFmpeg aggregates small NAL units, so SPS and PPS commonly arrive in one
// STAP-A rather than as packets of their own.
func TestParamSetsFromSTAPA(t *testing.T) {
	sei := []byte{0x06, 0x05, 0x01, 0xff}
	var p h264ParamSets
	p.observe(stapA(sei, testSPS, testPPS))
	if got := p.sprop(); got != testSprop {
		t.Fatalf("sprop = %q, want %q", got, testSprop)
	}
}

// Slices and fragments carry no parameter sets and must not be mistaken for
// them — an IDR's first byte is not an SPS just because the stream is H.264.
func TestParamSetsIgnoreSlicesAndFragments(t *testing.T) {
	var p h264ParamSets
	for _, payload := range [][]byte{
		{0x65, 0x88, 0x84},       // IDR slice
		{0x41, 0x9a, 0x00},       // non-IDR slice
		{0x7c, 0x85, 0x88, 0x84}, // FU-A, start of an IDR
		{},
	} {
		p.observe(payload)
	}
	if got := p.sprop(); got != "" {
		t.Fatalf("no parameter sets were sent, got sprop %q", got)
	}
}

// A STAP-A whose size field overruns the packet is malformed input from the
// network side of a UDP socket; it must be abandoned, never read past.
func TestParamSetsSurviveMalformedSTAPA(t *testing.T) {
	var p h264ParamSets
	p.observe([]byte{0x18, 0x00, 0x40, 0x67}) // claims 64 bytes, has 1
	p.observe([]byte{0x18, 0x00})             // truncated size field
	p.observe([]byte{0x18, 0x00, 0x00})       // zero-length NAL
	if got := p.sprop(); got != "" {
		t.Fatalf("malformed input produced sprop %q", got)
	}
}

// The RTP read buffer is reused for every packet, so a stored NAL must not
// alias the slice it was read from.
func TestParamSetsCopyTheirInput(t *testing.T) {
	sps := append([]byte(nil), testSPS...)
	pps := append([]byte(nil), testPPS...)
	var p h264ParamSets
	p.observe(sps)
	p.observe(pps)
	for i := range sps {
		sps[i] = 0
	}
	for i := range pps {
		pps[i] = 0
	}
	if got := p.sprop(); got != testSprop {
		t.Fatalf("sprop changed when the read buffer was reused: %q", got)
	}
}

// A source change kills the old FFmpeg without waiting, so its last packets
// can still be in the UDP buffer after the reset. They must not become the new
// stream's parameter sets; the new encode's, arriving later, must.
func TestParamSetsIgnoreLeftoversFromThePreviousEncode(t *testing.T) {
	oldSPS := append([]byte(nil), testSPS...)
	oldSPS[len(oldSPS)-1] ^= 0xff // a different stream's SPS

	var p h264ParamSets
	p.reset()
	p.observe(stapA(oldSPS, testPPS)) // leftover, read just after the reset
	if got := p.sprop(); got != "" {
		t.Fatalf("a leftover from the previous encode was captured: %q", got)
	}

	settled()
	p.observe(stapA(testSPS, testPPS)) // the new encode's first keyframe
	if got := p.sprop(); got != testSprop {
		t.Fatalf("sprop = %q, want the new encode's %q", got, testSprop)
	}
}

func TestParamSetsReset(t *testing.T) {
	var p h264ParamSets
	p.observe(stapA(testSPS, testPPS))
	p.reset()
	if got := p.sprop(); got != "" {
		t.Fatalf("sprop survived reset: %q", got)
	}
}

func TestH264OfferCarriesSprop(t *testing.T) {
	s := NewSidecar()
	s.setActiveProfile(mustProfile(t, "h264_vaapi"), "/dev/dri/renderD128", 1280, 720, 30)
	settled()
	s.paramSets.observe(stapA(testSPS, testPPS))

	want := "sprop-parameter-sets=" + testSprop
	if got := s.videoCodec().SDPFmtpLine; !strings.Contains(got, want) {
		t.Errorf("track capability fmtp %q lacks %q", got, want)
	}
	if got := s.videoCodecs()[0].SDPFmtpLine; !strings.Contains(got, want) {
		t.Errorf("registered codec fmtp %q lacks %q", got, want)
	}
}

// The parameter sets belong to the encode that produced them. A new source
// may be a different resolution, and an SPS for the old one would describe a
// stream that is no longer being sent.
func TestNewSourceForgetsParamSets(t *testing.T) {
	s := NewSidecar()
	s.setActiveProfile(mustProfile(t, "h264_vaapi"), "/dev/dri/renderD128", 1280, 720, 30)
	settled()
	s.paramSets.observe(stapA(testSPS, testPPS))
	if !strings.Contains(s.videoCodec().SDPFmtpLine, "sprop-parameter-sets") {
		t.Fatal("precondition: the first source's parameter sets were never captured")
	}
	s.setActiveProfile(mustProfile(t, "h264_vaapi"), "/dev/dri/renderD128", 1920, 1080, 30)

	if got := s.videoCodec().SDPFmtpLine; strings.Contains(got, "sprop-parameter-sets") {
		t.Fatalf("offer for the new source still carries the old SPS: %q", got)
	}
}

func TestSpropCanBeSwitchedOff(t *testing.T) {
	t.Setenv("SIDECAR_H264_SPROP", "0")
	s := NewSidecar()
	s.setActiveProfile(mustProfile(t, "h264_vaapi"), "/dev/dri/renderD128", 1280, 720, 30)
	settled()
	s.paramSets.observe(stapA(testSPS, testPPS))
	if s.paramSets.sprop() == "" {
		t.Fatal("precondition: parameter sets were never captured, so the flag proves nothing")
	}

	if got := s.videoCodec().SDPFmtpLine; strings.Contains(got, "sprop-parameter-sets") {
		t.Fatalf("SIDECAR_H264_SPROP=0 still advertises parameter sets: %q", got)
	}
}

// VP9 is the codec that works. Nothing here may touch its offer.
func TestSpropNeverReachesVP9(t *testing.T) {
	s := NewSidecar()
	s.setActiveProfile(mustProfile(t, "vp9_vaapi"), "/dev/dri/renderD128", 1920, 1080, 30)
	settled()
	// Observed directly, bypassing the read loop's capture flag, so the only
	// thing that can keep it out of the offer is the codec check.
	s.paramSets.observe(stapA(testSPS, testPPS))

	if got := s.videoCodec().SDPFmtpLine; got != "" {
		t.Fatalf("VP9 must negotiate on its name alone, got fmtp %q", got)
	}
}

// The wait for parameter sets happens on the offer path of a new viewer. It
// must end when they arrive, not run out its limit.
func TestAwaitParamSetsReturnsWhenTheyArrive(t *testing.T) {
	s := NewSidecar()
	s.setActiveProfile(mustProfile(t, "h264_vaapi"), "/dev/dri/renderD128", 1280, 720, 30)
	go func() {
		settled()
		s.paramSets.observe(stapA(testSPS, testPPS))
	}()

	start := time.Now()
	s.awaitParamSets("test", 5*time.Second)
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("waited %s for parameter sets that arrived after %s", took, paramSetSettle)
	}
	if s.paramSets.sprop() == "" {
		t.Fatal("await returned without parameter sets")
	}
}

func TestAwaitParamSetsSkipsNonH264(t *testing.T) {
	s := NewSidecar()
	s.setActiveProfile(mustProfile(t, "vp9_vaapi"), "/dev/dri/renderD128", 1920, 1080, 30)

	start := time.Now()
	s.awaitParamSets("test", 5*time.Second)
	if took := time.Since(start); took > 500*time.Millisecond {
		t.Fatalf("a VP9 viewer waited %s for H.264 parameter sets", took)
	}
}

// The oracle: FFmpeg writes sprop-parameter-sets into its own SDP from the
// encoder's extradata. Capturing them off the RTP that same run sends must
// produce the identical string, or the offer would advertise parameter sets
// that do not describe the stream. Needs an FFmpeg with libx264, so it runs
// wherever one is on PATH or named by SIDECAR_TEST_FFMPEG, and skips in CI.
func TestSpropMatchesFFmpegOwnSDP(t *testing.T) {
	ffmpeg := os.Getenv("SIDECAR_TEST_FFMPEG")
	if ffmpeg == "" {
		var err error
		if ffmpeg, err = exec.LookPath("ffmpeg"); err != nil {
			t.Skip("no ffmpeg; set SIDECAR_TEST_FFMPEG to run this")
		}
	}

	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadBuffer(8 << 20)
	port := conn.LocalAddr().(*net.UDPAddr).Port
	sdpPath := filepath.Join(t.TempDir(), "oracle.sdp")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// +global_header puts the parameter sets in extradata, which is where
	// FFmpeg's SDP writer reads them; dump_extra then re-inserts them in-band
	// exactly as the production profiles do.
	cmd := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-loglevel", "error",
		"-re", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-t", "2",
		"-pix_fmt", "yuv420p", "-c:v", "libx264", "-profile:v", "baseline",
		"-bf", "0", "-g", "30", "-flags", "+global_header",
		"-bsf:v", "dump_extra=freq=keyframe",
		"-payload_type", "102", "-f", "rtp", "-pkt_size", "1200",
		"-sdp_file", sdpPath, "rtp://127.0.0.1:"+strconv.Itoa(port))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	// Observed straight into a sidecar running the same H.264 profile, so the
	// test also covers the capture flag and the path into the offer.
	s := NewSidecar()
	s.setActiveProfile(EncoderProfile{
		Key: "h264_software", MimeType: webrtc.MimeTypeH264, PayloadType: 102, NeedsFmtp: true,
	}, "", 1280, 720, 30)
	settled()

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	buf := make([]byte, 1500)
	for running := true; running; {
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("ffmpeg: %v\n%s", err, stderr.String())
			}
			running = false
		default:
		}
		_ = conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		n, _, err := conn.ReadFromUDP(buf)
		if err != nil {
			continue
		}
		var pkt rtp.Packet
		if pkt.Unmarshal(buf[:n]) == nil && s.captureParamSets.Load() {
			s.paramSets.observe(pkt.Payload)
		}
	}

	sdp, err := os.ReadFile(sdpPath)
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`sprop-parameter-sets=([A-Za-z0-9+/=]+,[A-Za-z0-9+/=]+)`).FindSubmatch(sdp)
	if m == nil {
		t.Fatalf("FFmpeg's SDP carries no sprop-parameter-sets to compare with:\n%s", sdp)
	}
	if got, want := s.paramSets.sprop(), string(m[1]); got != want {
		t.Fatalf("captured sprop %q, FFmpeg advertised %q", got, want)
	}

	// And the value survives into the offer this sidecar would send.
	if fmtp := s.videoCodec().SDPFmtpLine; !strings.Contains(fmtp, string(m[1])) {
		t.Fatalf("offer fmtp %q does not carry the captured parameter sets", fmtp)
	}
}
