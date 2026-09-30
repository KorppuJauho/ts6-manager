package main

import (
	"strings"
	"testing"
)

// stubAV1Decode replaces the probe for one test.
func stubAV1Decode(t *testing.T, ok bool) {
	t.Helper()
	orig := canDecodeAV1
	canDecodeAV1 = func(string, string) bool { return ok }
	t.Cleanup(func() { canDecodeAV1 = orig })
}

// FFmpeg's own AV1 decoder has no software path in this FFmpeg: forced where
// it cannot use the GPU, the stream fails. Only an AV1 source, decoding on a
// GPU that passed the probe, may get it.
func TestAV1DecoderIsForcedOnlyWhereTheGPUDecodesAV1(t *testing.T) {
	for _, c := range []struct {
		codec, hwaccel string
		probe          bool
		want           string
	}{
		{"av1", "cuda", true, "av1"},
		{"av1", "vaapi", true, "av1"},
		{"av1", "cuda", false, ""}, // GPU without AV1 decoding: libdav1d
		{"av1", "", true, ""},      // decoding on the CPU anyway
		{"vp9", "vaapi", true, ""}, // not AV1: the default decoder uses the GPU already
		{"h264", "cuda", true, ""},
		{"", "cuda", true, ""}, // codec unknown: never guess
	} {
		stubAV1Decode(t, c.probe)
		if got := av1Decoder(c.codec, c.hwaccel, "/dev/dri/renderD128"); got != c.want {
			t.Errorf("codec %q, hwaccel %q, probe %v: got %q, want %q", c.codec, c.hwaccel, c.probe, got, c.want)
		}
	}
}

// Like -hwaccel, a forced decoder is an input option: it must sit in front of
// the video input, never the audio of a DASH pair, and never without a hwaccel.
func TestInputArgsForceTheDecoderOnTheVideoInputOnly(t *testing.T) {
	video, audio := "https://example.test/v.mp4", "https://example.test/a.webm"

	got := strings.Join(inputArgs([]string{video, audio}, "cuda", "av1"), " ")
	if !strings.Contains(got, "-hwaccel cuda -c:v av1 -i "+video) {
		t.Errorf("AV1 decoder not forced on the video input: %q", got)
	}
	if strings.Count(got, "-c:v") != 1 {
		t.Errorf("the decoder must apply to the video input only: %q", got)
	}

	if got := strings.Join(inputArgs([]string{video}, "", "av1"), " "); strings.Contains(got, "-c:v") {
		t.Errorf("no decoder may be forced without a hwaccel: %q", got)
	}
}

// A probe with no GPU to run on answers no without starting FFmpeg.
func TestAV1ProbeNeedsAGPU(t *testing.T) {
	if probeAV1Decode("", "") {
		t.Error("no hwaccel: AV1 cannot decode on a GPU")
	}
	if probeAV1Decode("vaapi", "") {
		t.Error("VAAPI without a render node cannot decode")
	}
}

func TestAV1ProbeSampleIsEmbedded(t *testing.T) {
	// An IVF file starts with the signature "DKIF", then the fourcc AV01.
	if len(av1ProbeSample) < 32 || string(av1ProbeSample[:4]) != "DKIF" || string(av1ProbeSample[8:12]) != "AV01" {
		t.Fatalf("av1-probe.ivf is missing or not an AV1 IVF file (%d bytes)", len(av1ProbeSample))
	}
}

// The capabilities describe the host: its hardware profiles' decode hwaccel.
func TestHostDecodeHWAccel(t *testing.T) {
	t.Setenv("SIDECAR_HW_BACKEND", "nvenc")
	if got := hostDecodeHWAccel(""); got != "cuda" {
		t.Errorf("NVENC host decodes with %q, want cuda", got)
	}

	t.Setenv("SIDECAR_HW_BACKEND", "vaapi")
	if got := hostDecodeHWAccel(""); got != "" {
		t.Errorf("VAAPI with no render node decodes with %q, want the CPU", got)
	}
	if got := hostDecodeHWAccel("/dev/dri/renderD128"); got != "vaapi" {
		t.Errorf("VAAPI host decodes with %q, want vaapi", got)
	}

	t.Setenv("SIDECAR_HW_DECODE", "0")
	if got := hostDecodeHWAccel("/dev/dri/renderD128"); got != "" {
		t.Errorf("SIDECAR_HW_DECODE=0 decodes with %q, want the CPU", got)
	}
}

func TestVideoCodecIsOneOfTheKnownNames(t *testing.T) {
	for _, ok := range []string{"", "av1", "vp9", "h264"} {
		if !videoCodecRe.MatchString(ok) {
			t.Errorf("%q should be accepted", ok)
		}
	}
	for _, bad := range []string{"av01.0.13M.08", "AV1", "av1 -i x", "hevc", "-c:v"} {
		if videoCodecRe.MatchString(bad) {
			t.Errorf("%q should be refused", bad)
		}
	}
}
