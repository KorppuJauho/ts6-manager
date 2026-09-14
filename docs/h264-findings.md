# H.264: what is known, and what is not

H.264 negotiates with the TeamSpeak client, connects, delivers every packet,
and renders nothing. Audio on the same peer connection plays. This file is the
record so the next attempt does not re-walk the same ground.

## Ruled out, with evidence

**Not the encoder.** `h264_vaapi` runs on the GPU — the capability probe
passes, there is no fallback to `libx264`, and FFmpeg reports
`Video: h264 (Constrained Baseline), vaapi(...), encoder: Lavc59.37.100
h264_vaapi` with frame counters advancing at ~30fps and `speed` near 1.0.

**Not missing parameter sets.** Encoding two seconds through the same path and
dumping the bitstream gives `00 00 00 01 67 42 40 28` — `0x67` is an SPS at the
head of the stream. `-bsf:v dump_extra=freq=keyframe` works.

**Not the profile.** Both sides agree on Constrained Baseline (`42e0…`), which
is what the client's own answer asks for.

**Not the level, and not the resolution.** This one took two attempts:

- First the offer hardcoded `42e01f` (level 3.1) while the encoder stamped
  level 4.0 for 1080p. Real mismatch, fixed by computing the level from the
  frame size. Still black.
- Then, since the client answers `42e01f` *whatever* is offered, the stream was
  capped to 720p30 so the offer, the answer and the SPS would all agree at
  level 3.1. **Still black.** Offer and answer both read
  `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f`,
  1280x720 fits level 3.1 with room to spare, and there is no picture.

So level and resolution are eliminated as causes.

**Not the keyframe gate.** `[Peer N] Stream gate opened` appears every time;
RTP is written to the track.

**Not the client refusing H.264.** Its answer carries the video m-line,
`a=recvonly`, `a=rtpmap:102 H264/90000` and an fmtp line. It accepts.

## What has not been examined

- **The RTP payload itself.** Nobody has captured the packets the client
  receives and checked the FU-A/STAP-A framing, the marker bit on the last
  packet of each access unit, or whether SPS/PPS survive into RTP. Every
  sampled packet logged `marker=false`, though the sampling interval (every
  600th) makes that weak evidence either way.
- **What TeamSpeak's own client sends.** The most direct comparison available:
  capture a TeamSpeak-to-TeamSpeak video stream and diff its SDP and RTP
  against this one. TeamSpeak natively uses **AV1 and H.264**, so a working
  H.264 example exists to compare against.
- **AV1.** Named alongside H.264 as a codec TeamSpeak uses natively. Untried
  here; would need an encoder the host can run.

## What the client actually runs

Its settings expose both paths. There is a "Use Cisco OpenH264" toggle, which
is why OpenH264 was the starting assumption — that was accurate reporting of
what the client advertises. But the same settings screen exposes an **NVIDIA
NVENC H.264 encoder (h264_nvenc)** page whose options are FFmpeg's AVOption
names verbatim: `forced-idr`, `rc-lookahead`, `spatial-aq`, `multipass`,
`tune`, `zerolatency`, `nonref_p`, `dpb_size`. And its Connection Info reports
`Decoder: FFmpeg (av1_cuvid)`.

So FFmpeg is in the client's H.264 path on both sides, with OpenH264 as a
separate software option. Constraining our encode to what OpenH264 supports was
therefore constraining it to the wrong thing.

The client's own H.264 defaults, worth matching in an experiment: `tune` = ll
(low latency), `zerolatency` = 1, `forced-idr` = 1, `preset` = p6, 2-pass with
`multipass` = qres.

## Confirmed: the client decodes 1080p H.264, in hardware

Connection Info on an H.264 stream from another TeamSpeak client:

```
Quality (Current)  1920x1080 29fps
Decoder            FFmpeg (h264_cuvid)
```

This settles two things. There is **no resolution ceiling** — 1080p H.264
arrives and renders — so the 720p cap that was briefly shipped was wrong, and
the level theory is dead beyond argument. And the decoder is **`h264_cuvid`**,
NVIDIA's NVDEC through FFmpeg. OpenH264 is not in this path at all, so nothing
needed constraining to Constrained Baseline.

It also raises the odds on the IDR question below. `cuvid` is a *hardware*
decoder, and hardware decoders are markedly stricter than software ones about
needing a clean IDR access point before they will start: a software decoder can
often muddle along from a non-IDR I-frame, NVDEC generally will not. A stream
whose keyframes are I-but-not-IDR would plausibly play in a browser and show
nothing here — which is the shape of this whole bug.

## The next thing to check: are our keyframes IDR?

`forced-idr` exists in NVENC because an encoder can emit an I-frame that is not
an **IDR** — a picture that refreshes the decoder completely. Without an IDR, a
decoder joining an ongoing stream has no clean entry point: it receives data,
finds nothing it can start from, and displays nothing. That is precisely the
symptom here, and it fits every elimination so far.

`h264_vaapi` was run with `-g 30` and no equivalent flag. Nobody has checked
whether the keyframes it produces are IDR. The earlier bitstream dump confirmed
an SPS (`0x67`) at the head of the file but was not read past that.

**The check:** encode a few seconds through the same path and look for NAL unit
type 5 (byte `0x65` after a start code) rather than only type 1. If there are
none, that is the bug, and the fix is whatever makes VAAPI emit IDR at each
keyframe.

This costs one command and no deployment, and it should be the first thing
tried — before any further reasoning about profiles, levels or SDP.

## The premise this was built on was wrong

TeamSpeak's own Connection Info panel, on a stream from another client, reports:

```
Quality (Current)  2560x1440 30fps
Decoder            FFmpeg (av1_cuvid)
```

Two things follow.

**The client decodes with FFmpeg**, not with Cisco's OpenH264. Everything above
that constrained the encode to Constrained Baseline, and then to level 3.1,
came from assuming OpenH264's limits. FFmpeg decodes High profile at any level.
If H.264 decoding goes through FFmpeg too — likely, though only AV1 is
confirmed — then profile and level were never the constraint, and the `42e01f`
in the client's answer is a default in its SDP generation rather than a
statement of what it can handle.

**The client happily renders 1440p**, so there is no general resolution ceiling
either.

A next attempt should therefore *not* start by constraining the encode. Try
Main or High profile at the native resolution, and look at the RTP framing
instead — the FU-A/STAP-A packetisation and the marker bit are the part nobody
has inspected.

## AV1 is blocked, for two reasons

AV1 is the other codec TeamSpeak uses natively, and the panel above proves it
works at 1440p. It is still not a route from here:

- The deployment host decodes AV1 but cannot encode it. Software encoding
  (libaom, SVT-AV1) is not realistic for realtime on that CPU.
- More fundamentally, **check whether FFmpeg can packetise AV1 into RTP at
  all** before investing anything. The AV1 RTP payload format is recent, and
  the sidecar image ships FFmpeg 5.1. If `-f rtp` cannot carry AV1, no encoder
  makes a difference.

## Why VP9 is unaffected

VP8 and VP9 carry no level, profile or parameter sets in their SDP, so none of
the above can disagree. They stream 1080p on this same path without trouble.

## Where the code is

Branch `claude/h264-investigation`, which is `claude/cool-hamilton-2b25wi` plus
the H.264 profiles, the level derivation and the 720p cap. `main` deliberately
does not carry them: a codec that negotiates and shows a black screen is worse
than one that is absent, because nothing in any log says it failed.

`SIDECAR_DEBUG_LOGS=1` logs the full SDP offer and answer. That is on `main`,
because it is what finally made the negotiation legible and it is useful for
any codec. Leave it off in normal operation — an SDP carries ICE credentials
and every address the host gathered.
