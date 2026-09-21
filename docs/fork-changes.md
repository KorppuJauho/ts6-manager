# Fork changes

Every way this fork diverges from upstream, why, and what to watch when
merging upstream back in.

Upstream is [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager).
To diff against it directly:

```bash
git remote add upstream https://github.com/clusterzx/ts6-manager
git fetch upstream
git diff upstream/main...HEAD
```

## How this fork was reconstructed

The changes below were originally made in a ZIP download of the repository —
no git history, no branch. They were recovered by initialising a repository
over that folder, fetching the fork, and resetting the index to the commit the
ZIP came from so the edits surfaced as a diff.

That baseline is **`224bb7e`** (2026-08-06 03:02), identified by scoring every
commit in the history against the recovered tree; it differed in 38 files
where the next-best candidate differed in 71. The unmodified snapshot is
preserved on the branch `wip/local-changes`, whose single commit is the exact
ZIP contents. Nothing below is reconstructed from memory — each entry is a
hunk from that diff.

Two classes of difference in that diff were **not** carried forward, because
they were accidental rather than intended:

- **Reverted upstream features.** The ZIP predated several upstream commits in
  a way that showed up as deletions: `voice/lyrics.ts`, `discord/member-count.ts`,
  `utils/server-group-filter.ts` and `docs/recover-server-access.md`, plus the
  matching hunks in `discord-bridge.ts`, `embeds.ts`, `server-groups.routes.ts`
  and `Settings.tsx`. All are retained from upstream.
- **Dependency downgrades.** `tar`, `axios` and `postcss` were moved backwards
  and four pnpm overrides (`brace-expansion@1`, `brace-expansion@5`,
  `ip-address`, `postcss`) removed. Those pins were added upstream in `960c5ff`
  to close npm audit advisories, 14 minutes before the ZIP's baseline. Upstream
  versions are kept.

The fork was then rebased onto current `main`, which brings in the 2026-08-06
security release (`91a483f`): the MFA bypass via JWT token-class confusion,
yt-dlp argument injection, unauthenticated WebSocket, and the unguarded reads.
**The fork had been running without those fixes.**

## Divergences

### Hardware video encoding (VP9 on VAAPI)

| | |
|---|---|
| Commits | `feat(sidecar): encode VP9 on Intel VAAPI…`, `build(compose): pass the host GPU…` |
| Files | `packages/sidecar/main.go`, `Dockerfile.sidecar`, `docker-compose*.yml` |

Upstream encodes VP8 with libvpx on the CPU, which saturates a core at 1080p30.
This fork encodes VP9 on the Intel GPU.

The codec appears in **three places that must agree**, or the stream negotiates
one format and carries another:

1. `MediaEngine.RegisterCodec` — `MimeTypeVP9`, payload type 98
2. `NewTrackLocalStaticRTP` — the local track's codec capability
3. FFmpeg's `-payload_type`

Encoding is now selected from the web UI rather than hardcoded. `encoders.go`
declares each profile once — codec, payload type, encoder name, pixel format,
FFmpeg flags — and all three codec sites derive from that record. `GET
/capabilities` probes `ffmpeg -encoders` so the UI can distinguish a profile
this host can run from one it merely knows about, and a profile the host
cannot run falls back to the software encoder for the same codec.

**Partly-resolved regression.** The per-peer keyframe gate is applied again
when VP8 is the active codec. `isVP8KeyframeStart` still cannot read VP9, so a
VP9 stream opens the gate on the first packet and a viewer joining mid-frame
may see artefacts until the next keyframe. **Follow-up: write a VP9 keyframe
detector.**

Which codec gates is read from `s.gateKeyframe` **per packet**, not latched
when the forwarding goroutine starts. This is not a style preference: the
goroutines start with the process, before any source has chosen a codec, so a
latched value is always the default profile's — VP8's. The first version of
this fix latched it, and every VP9 payload was then handed to the VP8
descriptor parser. Those bytes can never satisfy it (a VP9 frame start sets
bit 0x08, so the VP8 partition index is never zero), the gate never opened,
and the stream was black while FFmpeg, ICE and the SSRCs all looked healthy.
`main_test.go` covers both halves.

Deployment depends on `/dev/dri` passthrough *and* group membership for the
unprivileged `sidecar` user — see the comments in `docker-compose.yml`.

Known-good reference: a UGREEN NASync DXP4800 Plus running this fork in
production since 2026-08, with `devices: /dev/dri:/dev/dri` and
`group_add: "105"` (the `render` group on that host — check yours with
`stat -c '%g' /dev/dri/renderD128`, it is not the same number everywhere).
VP9 hardware encoding works there for both IPTV and YouTube sources.

### A/V pacing removed

| | |
|---|---|
| Commit | `perf(sidecar): stop pacing RTP forwarding by track timestamp` |
| Files | `packages/sidecar/main.go` |

`processVideoRTP` and `processAudioRTP` no longer sleep against
`computeTrackDelay` before forwarding each new timestamp.

**Rationale unknown.** This was changed during the VP9 port and the author does
not recall why; the plausible reading is that encoder latency made the pacing
model overshoot. It is committed alone and touches nothing else, so
`git revert` on that one commit restores upstream behaviour.
`computeTrackDelay` and `resetSyncTiming` are deliberately still in the file.
**Follow-up: confirm whether audio drifts on long streams.**

### DASH source pairs

| | |
|---|---|
| Commit | `feat(streaming): stream DASH video+audio pairs…` |
| Files | `voice/voice-bot.ts`, `voice/streaming/types.ts`, `packages/sidecar/main.go` |

YouTube caps progressive formats at 720p, so `-f best` made the 1080p preset
unreachable. yt-dlp is now asked for `bestvideo+bestaudio`, and the two URLs
travel to the sidecar as one string joined by `|||` (`SOURCE_SEPARATOR` in
TypeScript, `sourceSeparator` in Go — **a wire format between two processes;
change both together**). `dynamic_range=SDR` is pinned because HDR tone-maps
badly through VAAPI.

`validSource` was extended to validate each segment separately and cap the
count at two. Upstream hardened it to accept only http(s) URLs specifically so
a source could not smuggle an FFmpeg flag; because it inspects the whole
string and the split happens later, `https://ok|||-flag` would otherwise have
passed. **When merging upstream changes to `validSource`, preserve the
per-segment loop.**

### Streaming presets

| | |
|---|---|
| Commit | `feat(streaming): default to 1080p and raise its bitrate to 5500k` |
| Files | `voice/streaming/types.ts`, `prisma/schema.prisma`, `voice/voice-bot-manager.ts` |

`DEFAULT_PRESET` 720p → 1080p; the 1080p preset's bitrate 4500k → 5500k (VP9
was visibly blocky on high-motion content at the old figure).

No migration accompanies the schema default: this deployment applies schema
with `prisma db push` on container start (`Dockerfile.backend`), and the
committed `migrations/` directory is a single one-off patch, not a replayable
history — `prisma migrate diff` cannot even replay it. **Schema changes in this
fork go through `db push`; do not add migration files.**

1440p and 2160p presets were added alongside, and the default is a setting
rather than a constant. The defect carried through the import — that
`startVideoStream` ignored `this.config.streamPreset`, so the per-bot column
was written by the UI and never read — is fixed: precedence is the caller,
then the bot's own column, then the configured default, with an unknown key
warning and falling back rather than failing the stream.

### Idle stream auto-stop

| | |
|---|---|
| Commit | `feat(streaming): auto-stop a video stream left with no viewers` |
| Files | `voice/voice-bot.ts` |

A stream with no viewers stops itself after five minutes; a viewer joining
cancels the countdown. An encode runs whether or not anyone is watching, so an
abandoned stream otherwise held a GPU encode session open indefinitely.

### Streams created public

| | |
|---|---|
| Commit | `feat(streaming): create video streams as public` |
| Files | `voice/streaming/stream-signaling.ts`, `voice/voice-bot.ts` |

`accessibility` is forced to `0` in `StreamSignaling`, **overriding whatever
the caller passed**. On a private server every member should be able to watch
any bot stream, and the upstream default was turning away viewers who were
entitled to watch.

Resolved. `StreamSignaling` honours the caller's `accessibility` again, and
the decision is made in `VoiceBot` from the `streamPublic` setting, still
defaulting to public.

### Bot speaks English

| | |
|---|---|
| Commit | `i18n(bot): speak English in TeamSpeak instead of French` |
| Files | `voice/music-command-handler.ts` |

Upstream's bot replies were a mix of French and English. All 39 user-visible
strings and the `!help` table are English. `«guillemets»` became `"straight
quotes"` (the French marks render inconsistently across TeamSpeak client
fonts), column padding was re-aligned for English label widths, and the French
aliases `!aide` and `!paroles` were dropped.

Resolved. `voice/bot-i18n/` holds one catalogue per language (English,
Finnish, French, German, Spanish, Italian), selected by a stored setting.
Every catalogue is typed `BotMessages`, so a key added to one and forgotten
elsewhere is a compile error; `messages(lang)` falls back to English for an
unknown value, because it comes from a database column.

Typing the keys surfaced a latent bug: `QueueItem.artist` is optional and was
interpolated directly, so a track with no artist metadata replied "Now
playing: undefined - Title".

### Live TV (`!tv`)

| | |
|---|---|
| Commit | `feat(bot): watch live TV from an M3U playlist with !tv` |
| Files | `voice/iptv.ts`, `voice/iptv.test.ts`, `voice/music-command-handler.ts` |

`!tv` lists channels, `!tv <name>` starts one, `!tv reload` refetches. Names
match loosely (spaces stripped) so `!tv mtv3` finds `MTV 3`. The playlist is
parsed once and cached for the process.

**Deviation from the fork as deployed:** the original hardcoded the playlist
URL — a private LAN address — and a ten-entry channel whitelist as module
constants. They were first moved to environment variables, and now live in the
`StreamSettings` row with an enable toggle and a channel sort order, editable
in the web UI. A private network address stays out of a public repository's
permanent history either way.

The URL is deliberately **not** passed through `validateUrl`: that helper's
SSRF guard refuses private addresses, and the expected deployment is an IPTV
proxy on the LAN. The command never accepts a URL from a TeamSpeak user — only
a name from the parsed list. Scheme, a 15s timeout and a 5 MB body cap are
enforced instead.

### Smaller changes

| Change | Commit | Why |
|---|---|---|
| Radio stations ordered by id | `fix(bot): list radio stations…` | `!radio <id>` means ids are what users type; alphabetical order renumbered them on every insert |
| `python3` + `build-essential` in base images | `build(docker): install a native-module toolchain…` | node-gyp builds `@discordjs/opus`, `cpu-features`, `ssh2` at install time |

### Settings, and the dependency fixes

The hardcoded values above are now a `StreamSettings` row, edited in
Settings → Streaming: hardware encoding and its device, the encoder profile,
the default preset, stream visibility, and the IPTV playlist, filter and sort.
The bot's language sits with the other bot settings in Settings → Music
Commands.

Encoder selection reaches the sidecar in the `POST /source` body rather than
its environment. This is not a style choice: in a container deployment the
sidecar is long-lived and its env is fixed at container start, so a setting
changed in the web UI could not reach it any other way.

Separately, `pnpm audit --audit-level high` was failing with 13 advisories —
all of them already red on `main`, but GitHub Actions was disabled on the fork
so nothing had reported it. Every one had a published fix, so they were
resolved with version bumps and overrides rather than added to
`auditConfig.ignoreGhsas`.

A later sweep cleared the advisories *below* that gate — CI only fails at
`high`, so eleven low and moderate findings had accumulated unreported. Nine
were fixable inside the majors already in use:

| Advisory | Reached via | Fix |
|---|---|---|
| undici ×3 (response desync, CRLF injection, cookie injection) | `discord.js` | override `^6.27.0` → `^6.28.0` |
| qs ×2 (array-limit bypass, DoS via attacker-controlled `isBuffer`) | `express` | new override `^6.16.0` |
| body-parser (size enforcement silently disabled) | `express` | new override `^1.20.6` |
| vitest / @vitest/mocker (path traversal) | direct dev dependency | `^4.1.8` → `^4.1.11` |
| react-router-dom (open redirect → XSS) | direct dependency | `^6.30.4` → `^6.30.6` |

The undici one is worth remembering: the override pinning it at `^6.27.0` —
added by the earlier sweep — was itself what held it one patch below the fix.
An override is a floor *and* a ceiling on attention; it does not age out.

`qs` and `body-parser` need overrides because they arrive through `express`,
and 4.22.2 is the last of the v4 line — there is no express release carrying
the fixes.

**Two remain, both `react-router`, both fixed only in >=7.18.0.** Neither is
reachable here, which is why the v7 major has not been forced:

- `deserializeErrors()` constructor injection (CVE-2026-53666) is an SSR
  hydration path. There is no SSR — no `renderToString`, `hydrateRoot` or
  `StaticRouter` anywhere; the frontend is a Vite SPA served by nginx.
- The `<Link>`/`useNavigate` backslash open redirect (CVE-2026-53669) needs an
  attacker-controlled target. There are no dynamic `<Link to={…}>`, and every
  `navigate()` call takes a literal path except `Login.tsx`'s
  `navigate(location.pathname, { replace: true })`, which returns to the path
  already open.

React Router 7 peers `react >=18`, so that upgrade does not drag React 19 in
with it — it is a routing-API migration on its own, not part of the React 19
cluster.

### Field fixes from the first production deploy

Four defects the refactor introduced or exposed, found on a real host rather
than in CI:

- **`!tv` was blocked by its own SSRF guard.** The IPTV *playlist* fetch
  deliberately bypasses `validateUrl`, but the channel URLs it returns went
  through `resolveVideoUrl`, which refuses private addresses — so every
  LAN-hosted channel failed with "Private/reserved IP addresses are blocked".
  `resolveVideoUrl` now takes an explicit `operatorConfigured` flag that only
  `!tv` sets. A TeamSpeak user cannot reach it: `!tv` takes a channel *name*
  and looks the URL up in the operator's parsed playlist.

- **The encoder probe was reporting profiles the GPU cannot run.**
  `ffmpeg -encoders` lists what the build was compiled with, not what the
  hardware supports. A build shipping `vp8_vaapi` on a GPU whose driver
  exposes no VP8 encode entrypoint offered it in the UI and then died at
  stream start with *"No usable encoding entrypoint found for profile
  VAProfileVP8Version0_3"*. The sidecar now test-encodes a few frames with
  each profile and reports only what actually works, cached per encoder and
  device. `/capabilities` takes the render node as a query parameter, because
  the answer is a property of the GPU rather than of FFmpeg.

- **`MusicBot.streamPreset` silently overrode the configured default.** No UI
  writes that column, so every row carries the schema default — which then
  won over Settings → Streaming, making the one preset an operator can set
  appear to do nothing. It is no longer read. The column stays as the seed for
  a per-bot override and must gain a UI before it is consulted again.

- **The encoder settings presented a cross product instead of two choices.**
  A hardware toggle plus a flat list of vp8/vp9 × software/vaapi let the two
  controls contradict each other, and made "VP9 (VAAPI hardware)" with the
  toggle off a reachable, meaningless state. The UI now offers a codec, and
  the toggle decides the backend; `effectiveEncoder` composes the profile from
  the two, so they cannot disagree. The codec dropdown marks a codec the GPU
  cannot encode, using the sidecar's probe rather than FFmpeg's build flags.

- **Switching the encoder to VP9 silently produced VP8.** With hardware
  acceleration off, `effectiveEncoder` returned an empty string for any VAAPI
  profile, which the sidecar reads as "no preference" and answers with its own
  default — `vp8_software`. Selecting VP9 therefore kept encoding VP8 and
  looked like the setting was being ignored. Turning hardware off now drops
  the hardware *backend* and keeps the codec: `vp9_vaapi` becomes
  `vp9_software`. The two controls could contradict each other and the
  resolution discarded the more specific one.

- **Presets could exceed what TeamSpeak accepts.** The server caps a stream at
  10 Mbit/s and drops one that exceeds it, which presents as an encoder
  failure. 2160p asked for 18000k. It is now 9500k, and `clampBitrate` holds
  any caller-supplied value under the ceiling.

### Second deploy: black video, and the ICE candidates nobody kept

- **VP9 streamed black.** The keyframe gate was choosing its parser once, at
  goroutine start, when the active profile was still the VP8 default. See
  "Hardware video encoding" above for why that wedges the gate shut and why
  the check now happens per packet.

- **Candidates arriving before the answer were rejected, not held.** The
  browser trickles ICE candidates as soon as it has the offer, which is before
  its answer has made the round trip back to the sidecar. Pion rejects
  `AddICECandidate` until the remote description is set, so those candidates —
  usually the host candidates, the ones most likely to give a direct path —
  were answered with `500 InvalidStateError: remote description is not set`
  and dropped. They are now buffered on the peer (capped, so a peer that never
  answers cannot grow it without bound) and flushed by `SetAnswer`. This is
  upstream behaviour, not a fork regression: connections still formed via the
  later candidates, which is why it read as log noise rather than a fault.

- **A restrictive umask on the checkout broke the backend container.**
  `Dockerfile.backend` copies the workspace manifests and `prisma/` from the
  build context, and COPY preserves their modes. A clone made under umask 0077
  arrives mode 0600 root-owned, and the production stage runs as `node`, so
  container start died with `EACCES: permission denied, open
  '/app/packages/backend/package.json'`. `chmod -R a+rX` on the host cleared
  it, but that made the deployment depend on the umask of whoever cloned the
  repository. The application code is now copied `--chown=node:node`, so those
  modes grant access to the user that runs it rather than denying it.
  `node_modules` stays root-owned: it is installed in-container and never
  carries host modes, and keeping it unwritable by the app denies the easiest
  place to persist code after a compromise.

### Quality of life: source-matched quality, and a bot that says what it plays

- **The encode follows the source's resolution.** A 720p TV channel streamed at
  the 1080p preset was upscaled: no more detail, 5500k spent carrying
  interpolated pixels, and a softer picture than the source. The backend now
  probes the resolved source with `ffprobe` and drops the preset to the largest
  one the source can fill. It only ever goes *down* — the configured preset is
  a ceiling an operator chose, so a 4K source does not pull a deliberate 720p
  stream up to 2160p — and an unmeasurable source keeps the configured preset
  rather than being guessed at.

  This applies to YouTube too, and not redundantly: the yt-dlp format filter
  caps height *at* the preset, so a video whose best format is 720p already
  arrived as 720p however high the preset was set.

  The probe opens its own short-lived connection to the source before FFmpeg
  opens one. `STREAM_PROBE_TIMEOUT_MS=0` disables it, for an IPTV subscription
  that permits only one concurrent connection.

  `setVideoSource` (changing source mid-stream) deliberately keeps the preset
  it started with: renegotiating dimensions under connected peers is a larger
  change than that path should make.

- **The bot's nickname says what it is streaming** — `Boten Anna - Streaming
  'MTV3'`. This extends the existing music/ICY nickname rather than restoring
  something: the pre-fork snapshot renamed the bot for queue tracks and radio
  metadata, never for video.

  `!tv` passes the channel name the viewer asked for, which reads better than
  the playlist URL behind it. A YouTube source gets its title from a second,
  parallel yt-dlp call — deliberately not another `--print` on the URL
  resolution, because that call is what makes streaming work and a cosmetic
  feature must not be able to change its output shape. The cost is one extra
  metadata request per stream start, counting against YouTube's bot-detection
  budget like any other. Anything else falls back to the source's hostname.

  TeamSpeak caps a nickname at 30 characters, and `" - Streaming ''"` spends 15
  of them. A bot name long enough to crowd out the title drops to the compact
  `Boten Anna ▶ MTV3` form instead, so the nickname never announces a stream
  without saying what of. Ending a video stream restores the queue track's
  nickname if one is playing, rather than wiping it.

### H.264

H.264 was tried in the pre-fork version, produced a black screen, and was
replaced with VP9. It is in the registry on the `claude/h264-investigation`
branch only — **not on `main`, because it still renders a black screen.** It
negotiates, connects and delivers every packet; audio on the same peer
connection plays. A codec that fails with nothing in any log saying so is
worse than one that is absent.

What follows is what the branch carries and why. Several of the reasons were
wrong and are marked as such — `docs/h264-findings.md` is the running record
of what is eliminated and on what evidence, and is the file to read first.

**In-band parameter sets.** FFmpeg gives SPS/PPS to the muxer as extradata.
When FFmpeg also writes the SDP, they come out as `sprop-parameter-sets`; here
pion writes the SDP and never sees that extradata, so unless the parameter sets
are *also* in the bitstream the decoder has nothing to configure itself from.
It renders nothing while FFmpeg, ICE and the RTP counters all look healthy —
the same silent black screen the stale keyframe gate produced, from a
completely different cause. `-bsf:v dump_extra=freq=keyframe` puts them ahead
of every keyframe. The filter compares before prepending, so it is harmless
where they are already present.

**Constrained Baseline, and saying so.** Both profiles encode Constrained
Baseline with B-frames off, and the offer advertises
`profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1`.

The reason given for this was wrong. It was that TeamSpeak decodes with
Cisco's OpenH264, which implements Constrained Baseline only — the client's
settings do expose a "Use Cisco OpenH264" toggle, so it was a fair reading of
what the client advertises. But the client's own Connection Info reports
`Decoder: FFmpeg (h264_cuvid)` on a working 1080p H.264 stream. FFmpeg decodes
Main and High at any level, so nothing needed constraining. The constraint is
kept because it is harmless and removing it is not the fix; it is not load
bearing.

That fmtp line is a third thing the codec sites must agree on, alongside the
mime type and the payload type: it is carried on `RegisterCodec` *and* on the
local track's capability, because a track whose capability does not match the
registered codec is not bound to it. Both come from one `videoCodec()` call so
they cannot drift apart.

**The level is computed from the frame size, not hardcoded.** The first
version advertised `42e01f` — Constrained Baseline *level 3.1*, which caps at
1280x720 — on the reasoning that every WebRTC implementation offers that string
and decoders do not enforce it. That reasoning was wrong, and a deploy proved
it: at 1080p, `h264_vaapi` stamps level 4.0 into the SPS (`00 00 00 01 67 42 40
28`, where `28` is level_idc 40) while the SDP promised 3.1. The peer
negotiated, connected, counted packets and rendered nothing — the third
variation of the same silent failure.

`h264LevelIdc` now walks Table A-1 and returns the lowest level whose frame and
macroblock-rate limits the stream fits inside, so 720p30 offers 3.1, 1080p30
offers 4.0 and 2160p30 offers 5.1. The frame *rate* has to bind as well as the
size: 720p60 needs a higher level than 720p30 even though the frame is
identical. The constraint bits stay at `e0`, the spelling every H.264 WebRTC
implementation uses; only the level byte moves.

Because the level depends on the resolution, the fmtp line cannot live in the
registry as a constant — the sidecar records the dimensions alongside the
active profile and `videoCodec()` builds the capability that the SDP and the
local track both use. An unknown size deliberately over-advertises (5.2): too
*low* a level is what breaks decoding.

`h264_vaapi` asks the driver for `constrained_baseline`. A GPU that exposes no
such encode entrypoint fails the probe and falls back to `libx264`. That
fallback was predicted to be common; on the deployment host it does not happen
at all — the GPU exposes the ConstrainedBaseline entrypoint and `h264_vaapi`
runs on it at ~30fps with speed near 1.0.

**Debugging aid.** `SIDECAR_DEBUG_LOGS=1` now logs the SDP offer and the
answer in full. A codec that negotiates and then renders nothing leaves no
error anywhere — the disagreement is only visible with both halves side by
side, which is how two wrong guesses were made before it existed. Off by
default: an SDP carries ICE credentials and host addresses.

**The 720p cap, and why it is gone.** With both halves of the SDP visible,
the client looked like it was capping H.264 at level 3.1:

```
Offer  a=fmtp:102 …profile-level-id=42e028    level 4.0, what a 1080p encode is
Answer a=fmtp:102 …profile-level-id=42e01f    level 3.1, what the client sends back
```

Level 3.1 allows 3600 macroblocks at 108000 per second: exactly 1280x720 at
30fps. So `presetForCodec` and `framerateForCodec` were added to hold H.264 to
720p30.

**That was wrong, and the code is deleted.** Capping to 720p30 — offer, answer
and SPS all agreeing at level 3.1 — was still black. And the client's
Connection Info shows it decoding 1920x1080 at 29fps from another TeamSpeak
client. There is no resolution ceiling; the `42e01f` in the answer is a
constant in the client's SDP generation, not a statement of what it can
decode. H.264 encodes at the configured preset like every other codec.

The level derivation above is kept regardless: advertising a level the stream
exceeds is a real bug whether or not it was *this* bug.

VP8 and VP9 are unaffected by any of this — VPx carries no level, profile or
parameter sets in its SDP, so there is nothing for the two sides to disagree
about. They stream 1080p on this same path without trouble.
