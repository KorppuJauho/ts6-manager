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

## Tried: offering several codecs, as TeamSpeak does

*Implemented, tested, and not the cause — see "NullVideoDecoder" below. Kept
for the reasoning and the escape hatches it introduced.*

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

**Both are now implemented on this branch.** The offer carries every codec in
the registry, active one first, and every one of them advertises the standard
feedback set:

```
m=video 9 UDP/TLS/RTP/SAVPF 102 96 98
a=rtpmap:102 H264/90000
a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f
a=rtcp-fb:102 goog-remb
a=rtcp-fb:102 ccm fir
a=rtcp-fb:102 nack
a=rtcp-fb:102 nack pli
a=rtcp-fb:102 transport-cc
a=rtpmap:96 VP8/90000
a=rtpmap:98 VP9/90000
```

(`transport-cc` comes from pion's interceptor registry, which was already
there — it had nothing to attach to before.)

### What to read from the deploy

Three things, in order of how much they would tell us.

1. **Does H.264 render now?** If yes, the single-codec offer was the bug.
2. **What does the client answer?** `SIDECAR_DEBUG_LOGS=1` prints both halves.
   The `m=` line of the answer is the interesting part: which payload types it
   keeps, and in what order. If it strips H.264 and keeps VP8 or VP9 while
   FFmpeg is encoding H.264, that is the client telling us it would rather not
   decode our H.264 — a much more specific statement than a black screen.
3. **Does it ask for a keyframe?** New log lines, no debug flag needed:
   `[Peer N] video PLI #1`, `FIR`, `NACK`. A receiver that cannot decode what
   it is being sent asks for a fresh picture. A stream of PLI would be the
   client saying, for the first time in this investigation, that it is
   unhappy — and silence is nearly as informative, because it would mean the
   client believes it is being served correctly.

### The risk, and the escape hatch

A client may answer *without* the codec being encoded. The local track carries
one capability, so if the answer drops it the track binds to nothing and
sends nothing — which would break VP9, the codec that currently works.

That has not been observed, but it has also never been tested. So it is a
flag, off by one environment variable and no rebuild:

```
SIDECAR_MULTI_CODEC_OFFER=0
```

Set that on the `ts6-sidecar` container and the offer goes back to the single
codec it has always carried. The RTCP feedback and the PLI logging stay
either way; they are not part of the risk.

A related gap, noticed while looking: the registered capability carries no
`RTCPFeedback` at all — no `nack`, no `nack pli`, no `ccm fir`, no
`goog-remb`, where pion's own `RegisterDefaultCodecs` sets all four. So our
SDP advertises no `a=rtcp-fb` lines and the client has no negotiated way to
ask for a keyframe. Weak on its own, since VP9 renders fine under the same
gap and a keyframe goes out every second regardless, but it is a second
difference from a normal WebRTC offer and it costs nothing to close.

## NullVideoDecoder: the client never builds an H.264 decoder

The multi-codec offer was deployed and tested. H.264 rendered black, and the
client's own Connection Info on that stream read:

```
Downstream          8.8 Mbps        Received Packets     10215
Jitter              32ms            Total Received       10.8 MB
Decoding Time       0ms             Lost Packets (in)    0
Quality (Current)   0x0 0fps        Decoder              NullVideoDecoder
```

**`NullVideoDecoder`** is the most informative thing in this investigation.
The client did not fail to decode. It never constructed a decoder — it
resolved the negotiated codec to nothing and installed a null implementation.
`Decoding Time 0ms` and `Quality 0x0 0fps` follow from that. And with 10.8 MB
received at zero loss the transport is flawless: nothing about RTP, framing,
keyframes or levels can explain a receiver that never built a decoder.

### Correction: the multi-codec offer did not break VP9

The first report of that deploy said VP9 was black too, and this file — along
with the commit that defaulted the offer off (`f4e7c7f`) — concluded that the
client *cannot* resolve a decoder from a multi-codec `m=` line. **That was
wrong.** A later run on the same multi-codec build, with the sidecar logging

```
[Peer 95] Offering video/VP9/98, video/VP8/96, video/H264/102 (sending video/VP9)
```

rendered VP9 at `1920x1080 30fps`, `Decoder: libvpx`, `Decoding Time 2ms`.
The client resolves a decoder from a multi-codec offer without trouble.

The earlier VP9 black screen was most likely not the codec at all. The same
log shows the failure mode that would produce one: a YouTube URL returning
`HTTP error 403 Forbidden`, FFmpeg exiting, and the viewer still connecting
to a stream with no video behind it. That run was not captured, so this is the
probable cause, not a proven one — but it is the lesson either way: a single
black screen is not evidence about the codec until the source is known to
have been playing.

The multi-codec offer stays off by default, now for the right reason: it does
not help H.264, and a single codec is the shape main ships and keeps H.264
tests to one variable.

### The controlled result

That later run is the cleanest comparison this investigation has produced:
same build, same offer shape, same source, same client, same session.

| Stream | Decoder | Quality |
|---|---|---|
| VP9 | `libvpx` | 1920x1080 30fps |
| H.264 | `NullVideoDecoder` | 0x0 0fps |

Everything is controlled except the codec. VP9 negotiates on its name alone —
no fmtp. H.264 is the codec whose decoder can be configured from the fmtp
line. That was the condition set out for implementing the next hypothesis.

### The RTCP feedback earned its keep

```
[Peer 15] video PLI #1
```

Once, right after the gate opened, and never again — the first time in this
investigation the receiver has said anything at all. It appears on the VP9
streams too, so on its own it is the ordinary PLI a receiver sends as it
starts, not a distress signal. What matters is what does not follow it: a
receiver with a working decoder and a broken stream keeps asking.

## sprop-parameter-sets: implemented

Every theory before `NullVideoDecoder` assumed the client was *trying* to
decode and failing. It is deciding, while it sets up the stream, that it has
no decoder for what is offered — before a packet arrives. That makes the fmtp
line the thing that matters, and ours had no **`sprop-parameter-sets`**.

Many H.264 receivers build the decoder at negotiation time from the SPS and
PPS carried there. In-band parameter sets — present and correct at every
keyframe, as established above — cannot help a decoder that was never built.

### How

The sidecar captures the SPS and PPS off the RTP FFmpeg is already sending
(`paramsets.go`), and the offer for a new viewer carries them:

```
a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e028;sprop-parameter-sets=Z0LA…,aMuD…
```

They are taken from the live stream, not from a separate probe encode, because
they must be byte-for-byte the ones in the stream: SPS content depends on
resolution, level and driver. A viewer who joins in the first second of a
stream waits, at most 2.5 s, for the first keyframe to supply them; every
later viewer does not wait.

They are forgotten when a new source starts — and for 150 ms after that,
anything that looks like one is ignored. A source change kills the old FFmpeg
without waiting, so its last packets can still be in the kernel's UDP buffer
and be read after the reset; both encodes use the same SSRC, so the packets
cannot be told apart. Time separates them: leftovers in a continuously-read
socket are gone in milliseconds, while a new FFmpeg took ~800 ms to emit its
first packet in the deployment logs. Without the window, a viewer joining just
after a source change could be offered the previous source's SPS — and the
logs show a peer created 208 ms after a source was set, so that is not
hypothetical.

**FFmpeg sends them only inside STAP-A packets.** Disabling STAP-A parsing
makes the capture come back empty on real FFmpeg output — so a parser that
handled only single-NAL packets would compile, pass the obvious unit test, and
never advertise anything. Both paths are handled and tested.

### Verified against FFmpeg itself

FFmpeg writes `sprop-parameter-sets` into its own SDP from the encoder's
extradata. `TestSpropMatchesFFmpegOwnSDP` runs a real libx264 encode through
the production arguments, captures the parameter sets off the RTP it sends,
and requires the result to equal the string FFmpeg itself advertised. It
passes; with STAP-A parsing disabled, it fails. The test needs an FFmpeg with
libx264, so it runs wherever `SIDECAR_TEST_FFMPEG` names one and skips in CI.

pion's H.264 codec matching compares only `packetization-mode` and
`profile-level-id`, so adding `sprop-parameter-sets` cannot stop the track
binding to the client's answer. VP9 is untouched: it has no fmtp line at all.

### Testing it

`SIDECAR_H264_SPROP` defaults on; `SIDECAR_H264_SPROP=0` removes it without a
rebuild, which makes the test a clean A/B on one variable:

1. H.264 stream, defaults → Connection Info **Decoder**.
2. If it now names a real decoder, repeat with `SIDECAR_H264_SPROP=0` and
   confirm it goes back to `NullVideoDecoder`. That proves the cause rather
   than a coincidence.
3. If it is still `NullVideoDecoder`, run once with `SIDECAR_DEBUG_LOGS=1` to
   capture the offer and the answer, then switch debug logs back off — an SDP
   carries ICE credentials. What the client answers to an H.264 offer that
   carries parameter sets is the next thing to read.

### Result: sprop-parameter-sets did not change it

Deployed. The offer carried the stream's own parameter sets, single codec:

```
m=video 9 UDP/TLS/RTP/SAVPF 102
a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e028;sprop-parameter-sets=Z0JAKJZU…,aM44gA==
```

The client still reported `NullVideoDecoder`. Its answer:

```
a=rtpmap:102 H264/90000
a=rtcp-fb:102 goog-remb
a=rtcp-fb:102 transport-cc
a=rtcp-fb:102 ccm fir
a=rtcp-fb:102 nack
a=rtcp-fb:102 nack pli
a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f
```

The capture is kept — it is verified correct, costs nothing, and some
receivers do use it — but it is not the fix. `SIDECAR_H264_SPROP=0` removes it.

## What NullVideoDecoder actually means

That answer is libwebrtc's: the `rtcp-fb` order (`goog-remb`, `transport-cc`,
`ccm fir`, `nack`, `nack pli`), the `o=` and `msid-semantic` lines, the
level-asymmetric `42e01f` reply to a `42e028` offer. The TeamSpeak client is
built on libwebrtc — which makes `NullVideoDecoder` something that can be read
in source rather than guessed at. From `video/video_receive_stream2.cc`
(checked on the webrtc-sdk mirror, `m125_release`):

```cpp
std::unique_ptr<VideoDecoder> video_decoder =
    config_.decoder_factory->Create(env_, decoder.video_format);
// If we still have no valid decoder, we have to create a "Null" decoder
// that ignores all calls. ...
if (!video_decoder) {
  video_decoder = std::make_unique<NullVideoDecoder>();
}
```

and `NullVideoDecoder::Decode` logs "doesn't support decoding" and returns
`WEBRTC_VIDEO_CODEC_OK` — it swallows every frame and reports success, which
is precisely a stream that connects, counts packets and shows nothing.

So the precise statement is: **TeamSpeak's own video decoder factory was asked
for a decoder for `H264; packetization-mode=1; profile-level-id=42e01f` and
returned none.** That is the same factory that produces `FFmpeg (h264_cuvid)`
for H.264 from other TeamSpeak clients, and `libvpx` for our VP9. It decodes
H.264; it declines *this* H.264.

Nothing in the stream can change that outcome — the factory is consulted with
the negotiated format before a packet is decoded. Everything that separates
our H.264 from a TeamSpeak client's lives in that format, and the obvious
candidate is the **profile**: `42e0` is Constrained Baseline.

TeamSpeak clients stream through NVENC, driven via FFmpeg's `h264_nvenc` — the
client's encoder settings page uses its AVOption names verbatim, and exposes
no profile setting. FFmpeg's `h264_nvenc` defaults to **Main**
(`{ .i64 = NV_ENC_H264_PROFILE_MAIN }` in `libavcodec/nvenc_h264.c`,
`release/7.0`). So H.264 from another TeamSpeak client is most likely Main —
the profile the factory demonstrably builds a decoder for — while ours is
Constrained Baseline, which it declines.

### Ruled out: OpenH264 being switched off

The client has a "Use Cisco OpenH264" toggle, and OpenH264 is the classic
Constrained Baseline codec, so a factory routing Constrained Baseline to a
disabled OpenH264 would explain everything. It does not: that toggle has been
**on** for every test in this investigation, and our Constrained Baseline got
`NullVideoDecoder` regardless. With NVENC available the client streams through
it automatically; the toggle does not bring a Constrained Baseline decoder
into play.

## The H.264 profile is now selectable

`SIDECAR_H264_PROFILE` picks what is encoded *and* what is advertised, from one
record (`h264Profiles` in `encoders.go`), so the two cannot disagree:

| Value | profile-level-id | h264_vaapi | libx264 |
|---|---|---|---|
| `constrained_baseline` (default) | `42e0xx` | `constrained_baseline` | `baseline` |
| `main` | `4d00xx` | `main` | `main` |
| `high` | `6400xx` | `high` | `high` |
| `constrained_high` | `640cxx` | `high` | `high` |

libwebrtc treats High and Constrained High as different profiles when matching
an offer against what the receiver supports, and which one TeamSpeak lists is
unknown — hence both. Every profile encodes with B-frames off and progressive
frames, which is what Constrained High requires. pion's H.264 match compares
the profile *and* constraint bytes and ignores only the level, and libwebrtc's
answer keeps the offered profile and constraint bits, so the track still binds.

Verified with a real encoder: the FFmpeg oracle runs every profile through the
production libx264 arguments and requires the SPS the encoder writes to carry
the profile_idc the offer names. All four pass; giving Main a wrong prefix
fails both it and the unit test.

### Testing it

One variable at a time, in the sidecar's `environment:` block, checking
Connection Info **Decoder** for each:

1. `SIDECAR_H264_PROFILE=main` — first, because it is what a TeamSpeak client's
   own NVENC stream most likely is.
2. `SIDECAR_H264_PROFILE=high`
3. `SIDECAR_H264_PROFILE=constrained_high`

The sidecar logs `[FFmpeg] H.264 profile: <name> (profile-level-id <prefix>…)`
at each stream start, which confirms the setting took. A profile the client
does not list at all shows up differently from a black screen: the H.264 line
is rejected and the stream fails to negotiate, which is itself an answer.

If a profile works it becomes the default — and it needs nothing from viewers,
who cannot be asked to change their client settings.

### Result: Main and High are rejected outright

Both negotiated nothing. The client's answer to a `6400` (High) offer, and
likewise to `4d00` (Main):

```
m=video 0 UDP/TLS/RTP/SAVPF 0
```

Port `0` rejects the video m-line: none of the offered codecs is one the client
lists as receivable, and pion then refuses to start the track (`unable to start
track, codec is not supported by remote`). So the client's receivable H.264
formats include Constrained Baseline — it answered `42e01f` to that — and
exclude Main and High.

That changes the question. The factory **lists** Constrained Baseline as
receivable and then **returns no decoder** when asked to build one for it.
Since Main and High are not receivable at all, a TeamSpeak client's own H.264 is
almost certainly Constrained Baseline too — which means the factory does build
a decoder for *some* Constrained Baseline format, and whatever separates that
format from ours is not the profile. It is something else in the negotiated
format: another fmtp parameter, its absence, or a value. That can only be read
off a real TeamSpeak offer. (`SIDECAR_H264_PROFILE` stays: the default is
unchanged, and it is how this was established.)

## Capturing a TeamSpeak client's own offer

`TS6_CAPTURE_STREAM_OFFERS=1` on the **backend** makes each bot ask to watch any
stream another client starts where the bot can see it — the viewer half of
TS6's stream signaling, `joinstreamrequest id clid msg is_remove`, whose
parameters webspeak3 recovered from `TeamSpeak.dll`. The streamer's client
answers with `notifyrespondjoinstreamrequest` carrying its SDP offer. The bot
logs the offer and withdraws with `is_remove=1`; it never answers, so no media
flows. (`streaming/offer-capture.ts`)

The logged offer has its addresses, ICE credentials and DTLS fingerprint
removed, so it can be pasted: what decides the decoder is the `m=`, `rtpmap`,
`fmtp` and `rtcp-fb` lines, and those are kept. A test fails if the redaction
is removed.

To capture:

1. Add `TS6_CAPTURE_STREAM_OFFERS=1` to the **backend** service's
   `environment:` block and redeploy. The backend logs
   `[OfferCapture] Enabled` when the bot connects.
2. In a TeamSpeak client, in the bot's channel, start a stream (screen share)
   with the client set to H.264 — after the bot has connected, since it reacts
   to the stream starting.
3. Accept the bot's request to watch if the client asks.
4. The backend logs `[OfferCapture] Offer from clid=…` through
   `[OfferCapture] End of offer`.
5. Remove the variable again afterwards: while set, the bot asks to watch every
   stream started where it can see.

Diffing that offer against ours is the comparison this file has been missing
since the beginning.

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
