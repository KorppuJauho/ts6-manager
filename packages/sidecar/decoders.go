package main

import (
	"bytes"
	"context"
	_ "embed"
	"log"
	"os/exec"
	"sync"
	"time"
)

// av1ProbeSample is five frames of AV1 (Main profile, 8-bit 4:2:0, 320x180),
// made from FFmpeg's test pattern:
//
//	ffmpeg -f lavfi -i testsrc=size=320x180:rate=25:duration=0.2 \
//	  -c:v libaom-av1 -cpu-used 8 -pix_fmt yuv420p -g 5 -b:v 100k -f ivf av1-probe.ivf
//
//go:embed av1-probe.ivf
var av1ProbeSample []byte

// FFmpeg decodes AV1 with libdav1d unless told otherwise, and libdav1d is a
// software decoder that ignores -hwaccel: an AV1 source decodes on the CPU
// even on a GPU that could decode it. On the NAS a 1440p60 source took two of
// its six CPU threads. FFmpeg's own AV1 decoder does use -hwaccel, but in this
// FFmpeg (5.1) it has no software path at all: forced onto a GPU without AV1
// decoding, it fails with "Your platform doesn't support hardware accelerated
// AV1 decoding" and the stream never starts. So it is forced only for an AV1
// source, only when the stream decodes on a GPU, and only once a probe has
// seen that GPU decode AV1.

var av1DecodeCache sync.Map // probeKey{hwaccel, device} -> bool

// probeAV1Decode answers whether FFmpeg's AV1 decoder runs on this hwaccel, by
// decoding the embedded sample with it. Cached per hwaccel and device, as the
// encoder probe is: the answer cannot change while the process runs.
func probeAV1Decode(hwaccel, device string) bool {
	if hwaccel == "" || (hwaccel == "vaapi" && device == "") {
		return false
	}
	if hwaccel != "vaapi" {
		device = ""
	}
	key := probeKey{encoder: "av1/" + hwaccel, device: device}
	if cached, ok := av1DecodeCache.Load(key); ok {
		return cached.(bool)
	}

	ok := runAV1DecodeProbe(hwaccel, device)
	av1DecodeCache.Store(key, ok)
	if ok {
		log.Printf("[Probe] AV1 decodes on the GPU (%s)", hwaccel)
	} else {
		log.Printf("[Probe] AV1 does not decode on the GPU (%s); AV1 sources decode on the CPU", hwaccel)
	}
	return ok
}

func runAV1DecodeProbe(hwaccel, device string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	args := []string{"-hide_banner", "-loglevel", "error"}
	if hwaccel == "vaapi" {
		// -hwaccel vaapi reuses the device -vaapi_device opens, as in a stream.
		args = append(args, "-vaapi_device", device)
	}
	args = append(args,
		"-hwaccel", hwaccel,
		"-c:v", "av1",
		"-f", "ivf", "-i", "pipe:0",
		"-f", "null", "-",
	)
	cmd := exec.CommandContext(ctx, getFfmpegPath(), args...)
	cmd.Stdin = bytes.NewReader(av1ProbeSample)
	return cmd.Run() == nil
}

// canDecodeAV1 is probeAV1Decode, replaceable in tests: a probe runs FFmpeg.
var canDecodeAV1 = probeAV1Decode

// av1Decoder is the decoder to force on the video input, or "" for FFmpeg's
// default. FFmpeg's own AV1 decoder is forced for an AV1 source that decodes
// on a GPU the probe has seen decode AV1; every other case keeps the default,
// which for AV1 is libdav1d on the CPU.
func av1Decoder(videoCodec, hwaccel, device string) string {
	if videoCodec != "av1" || hwaccel == "" || !canDecodeAV1(hwaccel, device) {
		return ""
	}
	return "av1"
}

// hostDecodeHWAccel is the hwaccel this host's hardware profiles decode with,
// or "" when streams here decode on the CPU. It is what the capabilities
// report: the settings page and the backend ask about the host, not about
// one stream.
func hostDecodeHWAccel(device string) string {
	for _, p := range encoderProfiles {
		if p.HWAccel == hwBackend() {
			return decodeHWAccel(p, device)
		}
	}
	return ""
}

// av1FallbackWindow is how soon after starting a stream with the forced AV1
// decoder an FFmpeg exit counts as that decoder failing, and the stream is
// started again on the default decoder.
const av1FallbackWindow = 5 * time.Second
