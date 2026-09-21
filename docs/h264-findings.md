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

- ~~**The RTP payload itself.**~~ Checked and clean: SPS, PPS and the IDR all
  survive the packetiser, recovered from the bitstream rather than from the
  SDP. See the section below.
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

## The 720p cap is removed

Now that 1080p is confirmed working into `h264_cuvid`, `presetForCodec` and
`framerateForCodec` are gone from this branch. H.264 encodes at the configured
preset like every other codec. The theory they implemented is recorded above;
the code implementing it is not worth keeping.

## Checked: the keyframes *are* IDR

`forced-idr` exists in NVENC because an encoder can emit an I-frame that is not
an **IDR** — a picture that refreshes the decoder completely. Without an IDR, a
decoder joining an ongoing stream has no clean entry point: it receives data,
finds nothing it can start from, and displays nothing. That is precisely the
symptom here, and it fits every elimination so far.

`h264_vaapi` is run with `-g 30` and no equivalent flag, and the earlier
bitstream dump confirmed an SPS (`0x67`) at the head of the file but was not
read past that. So the keyframes were counted: encode a few seconds through
the same path and tally NAL unit types, looking for type 5 (an IDR slice)
rather than only type 1.

**It was run, and the answer is that the stream is healthy.** Four seconds of
`h264_vaapi` through the same argument list, NAL types counted from the
Annex B bitstream:

```
  type  1 : 116     non-IDR slices
  type  5 : 4       IDR slices
  type  6 : 120     SEI
  type  7 : 4       SPS
  type  8 : 4       PPS
```

120 frames in four seconds is 30fps, and four IDRs at `-g 30` is exactly one
per GOP — each one preceded by its own SPS and PPS, which is `dump_extra`
doing its job at every keyframe rather than only at the head of the stream.
There is a clean random-access point every second. `h264_cuvid` has everything
it needs to start.

The one SEI per frame is VAAPI's normal picture-timing/buffering-period
message. It is not an anomaly and it is not stripped anywhere in the pipeline.

So the encoder output is correct. The bug is downstream of it.

## Checked: the RTP framing carries everything

Every stage from the source to the encoder's output bitstream is now
eliminated with evidence. The bitstream is well-formed H.264 that a hardware
decoder can enter. The SDP offer and the client's answer agree. The client
accepts the codec and decodes 1080p H.264 from other clients. The gate opens
and packets are written to the track.

That leaves exactly one surface nobody has looked at: what happens between
FFmpeg's `-f rtp` output and the client's depacketiser.

The sidecar does not packetise — FFmpeg does, and the sidecar reads whole
datagrams off a UDP socket, clones them, and hands them to
`TrackLocalStaticRTP.WriteRTP`, which rewrites SSRC and payload type and
leaves sequence number, timestamp, marker bit and payload alone. That path is
codec-blind, which is why VP9 survives it. H.264 is the first codec here whose
payload format needs *structure* across packets: FU-A fragments have to arrive
in order with start and end bits, STAP-A aggregates carry SPS/PPS, and the
marker bit is what tells the decoder an access unit is complete. Any of those
being wrong produces a stream that counts packets and renders nothing.

**The check:** send through the same `-f rtp` output and read it back with
FFmpeg's own depacketiser, then count NAL types again. If the same
7/8/5 pattern comes out the far side, RTP framing is sound and the search
moves to the client. If SPS/PPS or the IDRs vanish, that is the bug.

```sh
docker exec -i ts6-sidecar sh -s <<'EOF'
set -e
cd /tmp

# Encode through the sidecar's own H.264 argument list, out over RTP.
ffmpeg -hide_banner -loglevel error \
  -vaapi_device /dev/dri/renderD128 \
  -f lavfi -i testsrc=size=1280x720:rate=30 -t 8 \
  -vf format=nv12,hwupload \
  -c:v h264_vaapi -profile:v constrained_baseline -bf 0 \
  -b:v 1500k -g 30 -bsf:v dump_extra=freq=keyframe \
  -payload_type 102 -ssrc 11111111 -f rtp -pkt_size 1200 \
  -sdp_file /tmp/rtp.sdp rtp://127.0.0.1:5999 &
sender=$!

# Give the SDP a moment to be written, then depacketise the same RTP back.
sleep 1
ffmpeg -hide_banner -loglevel error \
  -protocol_whitelist file,udp,rtp -i /tmp/rtp.sdp \
  -t 6 -c copy -f h264 -y /tmp/rtp-out.h264 || true
wait $sender || true

ls -l /tmp/rtp-out.h264

# NAL types out the far side. POSIX awk only: no strtonum, no gawk.
od -An -tx1 -v /tmp/rtp-out.h264 | tr ' ' '\n' | grep -v '^$' | awk '
  function hexval(s,   h, l) {
    h = index("0123456789abcdef", substr(s, 1, 1)) - 1
    l = index("0123456789abcdef", substr(s, 2, 1)) - 1
    return h * 16 + l
  }
  /^00$/ { z++; next }
  /^01$/ { if (z >= 2) want = 1; z = 0; next }
  { if (want) { c[hexval($0) % 32]++; want = 0 } z = 0 }
  END { for (t in c) printf "  type %2d : %d\n", t, c[t] }
' | sort -n -k2
EOF
```

The same `7 / 8 / 5` pattern out the far side means FU-A, STAP-A and the
marker bit are all intact and the search moves to the client. Missing SPS/PPS
or missing IDRs means the packetiser is dropping them, and that is the bug.

One caveat on what this proves: it tests FFmpeg's depacketiser, not
TeamSpeak's. It can find a fault but cannot fully clear one — a stream FFmpeg
reassembles may still be framed in a way the client will not accept.

### It was run, and RTP carries everything

```
 30 00 00 01 06     SEI
 29 00 00 01 21     non-IDR slices
  1 00 00 01 65     IDR slice
  1 00 00 01 67     SPS
  1 00 00 01 68     PPS
```

Out the far side of the packetiser: 30 frames, one IDR, and the SPS and PPS
that go with it. FU-A fragmentation, aggregation and reassembly all work.

**The control that makes this meaningful is the SDP.** FFmpeg's RTP reader
will happily take parameter sets from `sprop-parameter-sets` in the SDP
instead of from the bitstream, which would have made a clean result worthless
— pion writes our real SDP and never sees FFmpeg's extradata. The generated
SDP was:

```
m=video 5999 RTP/AVP 102
a=rtpmap:102 H264/90000
a=fmtp:102 packetization-mode=1
```

No `sprop-parameter-sets`. The SPS and PPS above were recovered from the RTP
stream itself and from nowhere else.

Two things about the run, neither of which changes the answer. The reader
captured 30 frames rather than the 180 that six seconds implies, because the
`lavfi` source has no `-re` and the encode runs flat out — it had mostly
finished before the reader joined. And the earlier run's flood of
`non-existing PPS 0 referenced` / `no frame!` errors was join-time noise, not
a fault: roughly 22 frames of complaints from a reader that joined one second
in, ending when the next keyframe arrived with its parameter sets, which is
exactly what `-g 30` predicts.

The caveat above still stands — this is FFmpeg's depacketiser, not
TeamSpeak's. But there is no fault here to find.

## The strongest remaining lead: we offer one codec, TeamSpeak offers several

Observed on a client-to-client stream: **a viewer whose hardware cannot decode
AV1 gets H.264 instead, mid-stream, without the stream restarting.**

That is not something WebRTC does by accident. Switching payload type without
renegotiation means both codecs were in the same `m=` line from the start, and
the sender moves between them in-band. Every working TeamSpeak video stream is
therefore a multi-codec offer.

The sidecar registers **exactly one** video codec — `RegisterCodec` is called
once, with the active profile — so our `m=` line carries a single payload
type. That is a structural difference from every stream the client is known to
render, and it is now the least-examined thing left.

It suggests an experiment that costs one deploy: register VP9 *and* H.264,
and read the answer. Either the client picks one and renders it, which tells
us what it prefers when given the choice, or it behaves differently from the
single-codec case, which is itself the finding.

A related gap, noticed while looking: the registered capability carries no
`RTCPFeedback` at all — no `nack`, no `nack pli`, no `ccm fir`, no
`goog-remb`, where pion's own `RegisterDefaultCodecs` sets all four. So our
SDP advertises no `a=rtcp-fb` lines and the client has no negotiated way to
ask for a keyframe. Weak on its own, since VP9 renders fine under the same
gap and a keyframe goes out every second regardless, but it is a second
difference from a normal WebRTC offer and it costs nothing to close.

## A third route: a known-good reference

Self-host [Moepchi/webspeak3](https://github.com/Moepchi/webspeak3) and screen
share into TeamSpeak from a browser. Its `publish.ts` does a plain
`createOffer()` with no codec selection at all, so whatever TS6 negotiates is
the client's own choice — and the resulting SDP and RTP are a known-good
reference to diff this one against. It is the most direct answer available to
"what does TeamSpeak actually want", and it needs no encoder the host lacks.

It also needs the user to stand up new infrastructure, so it is a decision to
make rather than a command to run.

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

AV1 is the other codec TeamSpeak uses natively, the panel above proves it
works at 1440p, and a client that cannot decode it falls back to H.264
mid-stream without the stream restarting. It is still not a route from here:

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
