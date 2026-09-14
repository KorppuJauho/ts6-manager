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
