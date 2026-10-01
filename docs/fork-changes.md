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
This fork encodes VP9 on the Intel GPU. That ran in production from 2026-08
with `vp9_vaapi` hardcoded; the settings-driven path described below (encoder
registry, `/capabilities` probe, `POST /source` body) has since been confirmed
on the same NAS with both `h264_vaapi` and `vp9_vaapi`, the source decoded on
the GPU too (`vp9 (native) -> vp9 (vp9_vaapi)`): a 1440p VP9 stream at 13 %
sidecar CPU against 40 % for the same stream in software. Software VP8, VP9
and H.264 were run in the same pass.

**AMD** is covered too: the sidecar image carries Mesa's VA-API driver
(`mesa-va-drivers`, radeonsi) next to Intel's (`intel-media-va-driver-non-free`), and
libva picks the one matching the render node's kernel driver. AMD hardware has
no VP9 encoder, so there the encoder probe reports VP9 (VAAPI) unavailable and
H.264 is the codec to choose; decoding works for VP9 and H.264. Not tested on
AMD hardware. **NVIDIA** has no VA-API encoder; it has its own profile,
`h264_nvenc` — see "NVIDIA: H.264 on NVENC" below.

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

### A/V pacing: removed, then rebuilt to measure at arrival

| | |
|---|---|
| Commits | `perf(sidecar): stop pacing RTP forwarding by track timestamp` (removal) · `fix(sidecar): pace A/V against arrival time, and report it in Sender Reports` |
| Files | `packages/sidecar/main.go`, `packages/sidecar/pacing_test.go`, `README.md` |

The sidecar held each track so that video and audio left for the viewers in
step. The pacing was removed during the VP9 port without a recorded reason.
Measuring it afterwards found why it misbehaved, and that removing it had
not been the answer.

**Where the skew comes from.** Video leaves FFmpeg later than audio, and not
mainly because of the encoder. FFmpeg decodes the source with frame
threading, one frame in flight per thread, up to 16 threads: on a 24-core
host that is about 530 ms of video delay at 30 fps, with every encoder,
software VP8 included. Limiting the source decoder to one thread brings it
to about 30 ms. `-hwaccel cuda` does not remove it. NVENC adds about 60 ms
of its own, and its first frame comes about 250 ms later than a software
encoder's. The skew scales with core count, so a NAS sees less of it.

**Why the old pacer failed.** `computeTrackDelay` measured each track's
latency in the forwarding loop, after that loop's own sleep. Each sleep read
as latency, and the next sleep grew by the playout buffer's share of the
average, with nothing to stop it: the hold grew by about 150 ms every second
of streaming, to 2–3 s after 20 s, whatever the real skew. Once the held
video outgrew its 1024-packet queue, packets were dropped: 63 to 403 in a
20 s run. A lag that keeps growing and video that breaks up is the likely
reason it was removed. Before the video's first packet the audio was also
paced alone, so the first second went out up to 780 ms apart.

**Why removing it was not the answer.** Without pacing the viewers get the
raw skew, video about half a second behind audio on a many-core host. The
offset measured constant over 20 s, so this is a fixed lip-sync error, not
drift.

**The fix.**

- The reader measures each frame's latency when it arrives from FFmpeg
  (`recordFrame`); the forwarding loop only waits (`waitToSend`). Its sleep
  can no longer feed the measurement.
- Both tracks are sent at the same offset: the later track's latency plus
  `SYNC_PLAYOUT_BUFFER_MS` (50). The earlier track is held by the skew, the
  later one by the buffer alone.
- Until the second track starts, the first is held as if the second were as
  late as allowed, and the wait is re-asked every 10 ms, so it is released
  together with the second track's first frame. A source with no audio stops
  waiting after `SYNC_MAX_DELAY_MS`.
- New: `SYNC_MAX_DELAY_MS`, default 1000, caps both the hold and one bad
  timestamp's effect on the average; the old pacer had no cap. Measured
  skews reach 600 ms and NVENC's cold start 900 ms, and with the measurement
  fixed a high cap costs nothing on streams that are already in step.
  `VIDEO_QUEUE_SIZE` goes from 1024 to 4096 packets, room for a second of a
  4K stream.
- RTCP Sender Reports paired the wall clock with the last timestamp read
  from FFmpeg for each track, which reported the half-second skew as the
  intended sync; a receiver that follows its Sender Reports would reproduce
  it whatever the pacing did. They now report the media time being sent, on
  the clock both tracks are paced against (`senderReportRTPTime`).

Measured with the sidecar image's FFmpeg (Debian bookworm, 5.1.9) on the
RTX 5080 host (24 cores), a 1080p30 H.264 + AAC test file, 20 s runs. The
holds are how long the sidecar keeps a frame; the offset is between the
tracks as sent. The old pacer's holds are for the last 10 s, and were still
growing; the new pacer's are steady from the first 3 s.

| Encode path | Skew from FFmpeg (sent as is while pacing was removed) | Old pacer: hold video / audio, video packets dropped | New: hold video / audio, offset |
|---|---|---|---|
| VP8, decoder on 1 thread | 29 ms | 2228 / 2264 ms, 129 | 51 / 80 ms, 0 |
| VP8, threaded decode | 526 ms | 2139 / 2668 ms, 63 | 51 / 577 ms, 0 |
| NVENC, threaded decode | 586 ms | 2295 / 2890 ms, 159 | 51 / 636 ms, 0 |
| NVENC + CUDA decode | 587 ms | 2112 / 2700 ms, 72 | 51 / 638 ms, 0 |

The new pacer dropped no packets, and the first second went out within 5 ms.
Its only cost is the one it exists for: the earlier track waits for the
later, plus 50 ms. Long runs with the sidecar's exact flags held that: NVENC
for 30 minutes, software VP8 for 15, 4K NVENC for 10, 2.3 million video
packets, the offset 0 and the holds flat in every window.

On the NAS (UGREEN DXP4800 Plus, 6 threads, Intel VAAPI), the same harness in
a throwaway sidecar container:

| Encode path | Skew from FFmpeg | New: hold video / audio, offset, dropped |
|---|---|---|
| VP9 VAAPI 1080p | 260 ms | 51 / 311 ms, 0, 0 |
| H.264 VAAPI 1080p | 261 ms | 51 / 312 ms, 0, 0 |
| VP9 VAAPI 1080p, decoder on 1 thread | 63 ms | 50 / 114 ms, 0, 0 |
| VP9 VAAPI 4K 9500k, 3 min | 258–284 ms | 51 / 309–336 ms, 0, 0 of 187 072 |

`vp8_vaapi` fails to open its encoder on that GPU; the encoder probe falls
back to software.

In the TeamSpeak client, with an A/V sync test clip (a flash and a beep each
second): in step on the test stack with H.264 NVENC at 1080p and 4K, and on
the NAS with H.264 VAAPI at 1440p. A live IPTV channel played with its audio
ahead of the picture, but the same channel in Jellyfin did too: the offset
is the channel's own.

Both tracks are still assumed to start at media time zero, as the old pacer
assumed. A live source that starts its audio and video at different points
would break that, and FFmpeg's RTP output does not say; the IPTV check above
showed no sign of it.

### DASH source pairs

| | |
|---|---|
| Commits | `feat(streaming): stream DASH video+audio pairs…` · `fix(sidecar): reconnect a DASH pair's audio input too` |
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

**Each input takes its own options.** FFmpeg input options bind to the next
`-i` only, and `inputArgs` first put `-reconnect`, `-fflags` and `-re` in
front of the video input alone. The audio of a DASH pair is its own
connection, and YouTube resets connections mid-stream: the video reconnected,
the audio input failed with an I/O error, and the stream played on silent.
Seen twice in a row on the test stack with a one-minute clip. Every input now
gets the reconnect options (or `-stream_loop` for a file), `-fflags` and `-re`;
`-hwaccel` stays on the video input only. With the fix, a later run had both
connections reset and both reconnect.

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

Resolved. `StreamSignaling` honours the caller's `accessibility` again. The
decision was then a `streamPublic` setting, which has since been removed:
turning it off made no difference anyone could see, because the bot accepts
every join request itself. What viewers took for "waiting to be let in" was
the sidecar's ICE gathering (see "Viewers waited five seconds to join"
below). `VoiceBot` sends `accessibility=0`, what the setting defaulted to. The
`streamPublic` column stays in the schema, unread: the container applies the
schema with a plain `prisma db push`, which refuses to drop a column holding
data, and a failed push would leave every later schema change unapplied.

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
| `docker-compose.coolify.yml` removed | `chore(compose): remove the Coolify compose file…` | It ran upstream's Docker Hub images with no sidecar and no `SIDECAR_TOKEN`, and pinned one install's Coolify network ID; nobody deploys this fork on Coolify to keep it working |
| `docker-compose.hub.yml` and `docker-compose.dev.yml` removed | `chore: remove upstream's Docker Hub compose files…` | Both ran clusterzx's Docker Hub images (`clusterzx/ts6-manager:backend`, `:backend-dev`), so a deployment using either ran upstream's code with none of this fork in it. `docker-compose.yml` builds this fork and `docker-compose.ghcr.yml` runs its CI images |
| Translated READMEs removed | same commit | `README.{fr,de,es,it}.md` described `coom/ts6-manager` and none of this fork, and linked the removed Docker Hub compose file. The web UI keeps its five languages; only the READMEs went |

### Settings, and the dependency fixes

The hardcoded values above are now a `StreamSettings` row, edited in
Settings → Streaming: hardware encoding and its device, the encoder profile,
the default preset, and the IPTV playlist, filter and sort.
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

**2026-09-30: brace-expansion again.** GHSA-qhr7-859c-m2p7 (high: DoS through
unbounded recursion on nested brace groups) turned CI red overnight, on
`main` as on every branch. It is patched in >=1.1.20 and >=5.0.11, and the
two existing overrides were the floor holding the tree below that — the undici
lesson again. Raised to `^1.1.20` and `^5.0.11`; the lockfile resolves 1.1.21
and 5.0.12. Reached via `eslint` (dev) and `@discordjs/opus`'s install-time
tooling, neither at runtime. Regenerating the lockfile with pnpm 9.15.9, the
CI major, also dropped the `libc:` fields a newer pnpm had written; they are
platform metadata pnpm 9 neither writes nor needs.

The same sweep raised the `ip-address` override from `^10.3.1` to `^10.7.1`
(resolves 10.7.2): four moderate advisories, three SSRF / subnet-check bypasses
and a DoS, all patched in the same major. None was reachable. The only user is
`geoip-lite`, and only its `scripts/updatedb.js`, which rebuilds the GeoIP
data and is never run here; `geoip.lookup()` does not load it, and the URL
validator resolves with Node's `dns` and never touches it. Raised anyway, so
the old floor cannot hold a future runtime user below the fix. The audit is
down to the two unreachable `react-router` findings above.

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

- **Auto quality follows the source's resolution.** A 720p TV channel streamed
  at the 1080p preset was upscaled: no more detail, 5500k spent carrying
  interpolated pixels, and a softer picture than the source. The quality list
  now starts with **Auto**, the default for a new install: the backend probes
  the resolved source with `ffprobe` and encodes at the largest preset it can
  fill, up to the **Auto limit** setting (2160p unless lowered). The limit is
  a setting because the stream is sent to each viewer separately, so the
  upload is the bitrate times the audience, and only the operator knows what
  their connection carries. An unmeasurable source gets the limit rather than
  a guess; a limit that names no preset falls back to 2160p.

  A **named preset** is the opposite: encoded at exactly that size with no
  probe, upscaling a smaller source. The probe opens its own short-lived
  connection to the source before FFmpeg does, so a named preset is also how
  an IPTV subscription that permits one concurrent connection is streamed.
  That replaces `STREAM_PROBE_TIMEOUT_MS`, the environment variable that
  switched the probe off.

  An existing install keeps its saved preset, which now means a fixed size:
  before, a saved 1080p was a ceiling the source could lower. Choose Auto in
  Settings → Streaming for the old behaviour.

  This applies to YouTube too, and not redundantly: the yt-dlp format filter
  caps height *at* the limit, so a video whose best format is 720p arrives
  as 720p however high the limit is.

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

### H.264: Constrained High, the one profile TeamSpeak decodes

H.264 was tried before the fork, produced a black screen, and was replaced with
VP9. It is back in the registry (`h264_vaapi`, and `h264_software` on
`libx264`) and renders: 1080p30 through `h264_vaapi`, which the viewer decodes
on its GPU with `FFmpeg (h264_cuvid)`, where VP9 is decoded in software with
`libvpx`.

**What was wrong was the profile.** The TeamSpeak client builds an H.264
decoder only for Constrained High, `profile-level-id=640c…`. Its own stream
offer lists H.264 solely as `640c1f`. What it does with each profile, at
1080p30:

| Offered | Result |
|---|---|
| `42e028` Constrained Baseline | answered `42e01f`, then `NullVideoDecoder`: black |
| `4d0028` Main | m-line rejected (port 0), stream does not start |
| `640028` High | m-line rejected (port 0), stream does not start |
| `640c28` Constrained High | `FFmpeg (h264_cuvid)`, renders |

Constrained Baseline is the dangerous one: the client runs libwebrtc, which
installs `NullVideoDecoder` when the application's decoder factory returns
nothing for a negotiated format, and that decoder swallows every frame and
reports success. It negotiates, connects, counts packets and shows black, with
no error anywhere — which is how the pre-fork attempt, and this fork's first
four, failed without saying why.

`SIDECAR_H264_PROFILE` selects `constrained_high` (default),
`constrained_baseline`, `main` or `high`; the others are kept because they
are how this was established. The encoder's `-profile:v` and the SDP's
`profile-level-id` come from one `h264Profiles` entry, via `encodeArgs` and
`FmtpFor`, so they cannot disagree. Neither encoder has a Constrained High
spelling: both encode High with B-frames off (`-bf 0`), which is what
Constrained High permits, and the decoder is chosen from the SDP.

**The level is computed from the frame size.** `h264LevelIdc` walks Table A-1
for the lowest level whose frame-size and macroblock-rate limits the stream
fits: 720p30 offers 3.1, 1080p30 offers 4.0. The frame rate binds as well as
the size. The fmtp line therefore depends on the resolution, so the sidecar
records the dimensions with the active profile and `videoCodec()` builds the
one capability the SDP and the local track both use.

**Parameter sets travel in-band.** FFmpeg hands SPS/PPS to the muxer as
extradata; pion writes the SDP and never sees it, so
`-bsf:v dump_extra=freq=keyframe` puts them ahead of every keyframe, where a
viewer joining mid-stream finds them.

**How it was found.** A diagnostic on the `claude/h264-investigation` branch
(PR #6) made the bot ask to watch a TeamSpeak client's own H.264 stream and log
the offer that came back, which named `640c`. That branch keeps the full
record in `docs/h264-findings.md`, and the experiments that turned out not to
matter — `sprop-parameter-sets` in the fmtp, the RTCP feedback set, a
multi-codec offer, the offer capture itself — which are not on `main`.

`SIDECAR_DEBUG_LOGS=1` logs the full SDP offer and answer. It is what made
the negotiation legible, and it is useful for any codec. Off by default: an
SDP carries ICE credentials and every address the host gathered.

### The source is decoded on the GPU too

With hardware encoding on, the sidecar used the GPU only for the encode. The
source was decoded in software — `vp9 (native) -> h264 (h264_vaapi)` in
FFmpeg's log — so a 1080p VP9 YouTube stream spent its most expensive step on
the CPU. The video input now gets `-hwaccel vaapi`, reusing the device
`-vaapi_device` opened.

Only the decode moves. The frames come back to system memory for the `fps`,
`scale` and `pad` filters, which are software filters, and are uploaded again
for the encoder; that copy costs far less than the decode it replaces. A fully
GPU-side chain (`scale_vaapi`) is the next step, not taken here: padding to
the frame size has no VAAPI filter in the image's FFmpeg 5.1.

A GPU that cannot decode the source's codec or profile does not fail the
stream. The hwaccel's initialisation fails, libavcodec drops that format and
asks again, and FFmpeg picks the software one (`ff_get_format` and FFmpeg's
own `get_format`, release/5.1). `SIDECAR_HW_DECODE=0` turns it off without a
rebuild, should a driver decode something wrongly.

### AV1 decoded on the GPU, VP9 where it cannot be

| | |
|---|---|
| Commit | `feat(streaming): decode AV1 on the GPU, prefer VP9 where it cannot` |
| Files | `packages/sidecar/decoders.go`, `packages/sidecar/av1-probe.ivf`, `packages/sidecar/main.go`, `Dockerfile.sidecar`, `voice/streaming/source-format.ts`, `voice/voice-bot.ts`, `voice/streaming/sidecar-client.ts` |

The GPU decode above never reached AV1. yt-dlp ranks AV1 first and YouTube
offers it for many videos, and FFmpeg opens AV1 with libdav1d, a software
decoder that ignores `-hwaccel`: `av1 (libdav1d) -> h264 (h264_vaapi)`. On the
NAS a 1440p60 AV1 source took two of its six CPU threads, and the picture
stuttered slightly. FFmpeg's own `av1` decoder does use `-hwaccel` (VAAPI, CUDA),
but in 5.1 it has no software path: without a GPU that decodes AV1 it fails
with "Your platform doesn't support hardware accelerated AV1 decoding" and the
stream never starts. So it is forced only where it is known to work.

- **Probe.** The sidecar decodes a 1.4 kB AV1 sample (`av1-probe.ivf`,
  embedded; made from FFmpeg's test pattern with libaom) with `-hwaccel <gpu>
  -c:v av1`, once per device, like the encoder probe. `/capabilities` reports
  the result as `av1HwDecode`.
- **Format.** yt-dlp is asked for `-S res,fps,vcodec:vp9`: at the same
  resolution and frame rate VP9 wins, which the GPU decodes and which costs a
  CPU less; where AV1 is the only format at the best resolution, it is still
  taken. This first kept yt-dlp's AV1-first order on a GPU that passed the
  probe; see "VP9 before AV1, even on a GPU that decodes AV1" below for why it
  no longer does.
- **Decoder.** yt-dlp prints the chosen codec with the URLs, and the backend
  passes it to `/source` as `videoCodec`. The sidecar adds `-c:v av1`, next to
  `-hwaccel` on the video input, only for an AV1 source decoding on a GPU that
  passed the probe.
- **Fallback.** If FFmpeg exits within five seconds of starting with that
  decoder, the sidecar starts the same source again on libdav1d, unless the
  stream was stopped or replaced meanwhile.

Sources the backend does not resolve with yt-dlp (IPTV, direct URLs) carry no
codec, and keep FFmpeg's default decoder.

Measured with the 4K60 test video:

| Host | Probe | yt-dlp chose | Pipeline | Sidecar CPU |
|---|---|---|---|---|
| RTX 5080, NVENC | passes | AV1 4K60 | `av1 (native)` on CUDA → `h264_nvenc` | ~68 %, GPU decoder 10 % busy |
| Same, software encoding | not asked | VP9 4K | `vp9 (native)` → `libx264` | |
| NAS, Pentium Gold 8505, VAAPI | fails | VP9 4K60 | `vp9 (native)` on VAAPI → `h264_vaapi` | ~108 %, no stutter |

The NAS's GPU does decode AV1 (`vainfo` lists `VAProfileAV1Profile0:
VAEntrypointVLD`), but not with Debian's `intel-media-va-driver`: every frame
fails with "internal decoding error" and FFmpeg then segfaults, for the
embedded sample and a real YouTube AV1 stream alike. So the probe rejected it
and VP9 was chosen, as the fallback intends; VP9 at 4K still took half the CPU
the 1440p60 AV1 source did. The FFmpeg version was not the cause: Debian's
driver from bookworm (23.1.1), trixie (25.2.3) and sid (26.2.4, with FFmpeg
9.0) all fail, while bookworm's FFmpeg 5.1 decodes it with Intel's non-free
driver build. The image now installs that one; see "Intel's non-free VA-API
driver" below.

### Intel's non-free VA-API driver

| | |
|---|---|
| Commit | `fix(sidecar): install Intel's non-free VA-API driver so AV1 decodes on the GPU` |
| Files | `Dockerfile.sidecar` |

The sidecar image installs `intel-media-va-driver-non-free` from Debian's
`non-free` component, in place of `intel-media-va-driver` from `main`. Both are
the same Intel driver release (iHD 23.1 on bookworm). Debian's `main` build
removes the pre-built GPU kernels Intel ships without their source; the
non-free build keeps them. Without them AV1 does not decode on the NAS's Alder
Lake GPU, so the AV1 probe failed and VP9 was chosen.

Measured on the NAS in throwaway containers, each decode capped at 30 s:

| Driver | FFmpeg | Probe sample | Real AV1 1080p, 5 s | AV1 → `h264_vaapi` | `h264_vaapi`, `vp9_vaapi` |
|---|---|---|---|---|---|
| `intel-media-va-driver` 23.1.1 (bookworm) | 5.1 | fails | fails | fails | ok |
| `intel-media-va-driver` 26.2.4 (sid) | 9.0.2 | fails | fails | fails | ok |
| `intel-media-va-driver-non-free` (bookworm) | 5.1 | ok | ok, 2.0× real time | ok, 2.0× | ok |

The licence does not change: Intel's driver is MIT (Debian's "Expat"), and
Debian files the non-free package there only because the kernels come without
source. AMD's driver (`mesa-va-drivers`) and the NVIDIA path are untouched. The
build fails if the `non-free` component could not be enabled, rather than
failing later on a missing package with a less obvious message.

### VP9 before AV1, even on a GPU that decodes AV1

| | |
|---|---|
| Commit | `fix(streaming): prefer VP9 over AV1 even on a GPU that decodes AV1` |
| Files | `voice/streaming/source-format.ts`, `voice/voice-bot.ts` |

With the non-free driver the NAS's probe passed, yt-dlp kept its AV1-first
order, and the 4K test video decoded on the GPU (`av1 (native) -> h264
(h264_vaapi)`, sidecar ~90 % CPU). But the stream ran at 0.72–0.85× real time:
the client showed 22–25 fps instead of 30, and picture and audio stuttered.
The same video as VP9 had played cleanly.

The GPU decodes AV1 fast enough; copying the decoded frames back to the CPU is
what is slow, and slower for AV1 than for VP9. The sidecar does that for every
frame, because the frame-rate and scaling filters run on the CPU before the
frame is uploaded again for encoding. 4K60, 8 s of each, on the NAS:

| | AV1 | VP9 |
|---|---|---|
| Decode only, frames stay on the GPU | 2.0× | 8.3× |
| Decode and copy back to the CPU | 0.91× | 1.33× |
| The sidecar's pipeline (fps, scale, `h264_vaapi`) | 0.90× | 1.15× |

So yt-dlp now prefers VP9 everywhere, and the backend no longer asks the
sidecar whether its GPU decodes AV1 before resolving. The order is VP9 → AV1
on a GPU that passed the probe → AV1 on the CPU (libdav1d): AV1 is only chosen
where it is the best resolution on offer, and then still decodes on the GPU
where it can, which beats the CPU. NVENC hosts lose nothing: CUDA decodes VP9
too. `/capabilities` still reports `av1HwDecode`, for diagnosis.

**Preferring AV1 instead** (a GPU whose AV1 path keeps up, such as the RTX
5080 at ~68 % sidecar CPU for 4K60 AV1): the order is one constant,
`VIDEO_FORMAT_SORT` in `voice/streaming/source-format.ts`.

- *AV1 first everywhere:* set it to `'res,fps,vcodec:av01'`, and update the
  codec field its test in `source-format.test.ts` checks. The sidecar
  needs no change: it still decodes AV1 on a GPU that passed the probe and on
  the CPU (libdav1d) anywhere else, so a host without GPU AV1 decoding pays
  the CPU cost for every AV1 video.
- *AV1 first only where the GPU decodes it:* the order this change replaced.
  Commit `9c1026e` (`feat(streaming): decode AV1 on the GPU, prefer VP9 where it
  cannot`) has it: `videoFormatArgs` takes `gpuDecodesAV1` and leaves the sort
  out when it is true, and `VoiceBot.gpuDecodesAV1()` reads `av1HwDecode` from
  the sidecar's `/capabilities` before resolving. The sidecar still reports it.
  Measure first: on the NAS's GPU this order stuttered at 4K60.

Keeping the frames on the GPU (`scale_vaapi`, no copy back) would lift both
codecs well past real time and remove most of the sidecar's CPU use; a
separate change.

### NVIDIA: H.264 on NVENC

A second hardware backend beside VAAPI: the `h264_nvenc` profile, used when
the sidecar runs with `SIDECAR_HW_BACKEND=nvenc`. H.264 only, because NVENC has no VP8 or VP9
encoder — and H.264 Constrained High is what the TeamSpeak client decodes
anyway. The source is decoded on the same GPU with `-hwaccel cuda` (NVDEC),
with the same software fallback as VAAPI for a codec or profile the GPU
cannot decode.

What differs from VAAPI, and why:

- **No render node.** NVENC reaches the GPU through the CUDA driver, and the
  container runtime decides which GPU that is. `NeedsDevice()` is now true
  for VAAPI only; a device sent with an NVENC stream is ignored.
- **No `hwupload`.** NVENC takes system-memory frames and uploads them
  itself, so the filter chain is the software one.
- **The 4:2:0 conversion is load-bearing.** Given RGB input, `h264_nvenc`
  encoded *High 4:4:4 Predictive* and ignored `-profile:v high` (seen on the
  first test run). The stream's chain ends in `format=nv12`, and
  `TestH264ProfilesEncode420` keeps every H.264 profile there.
- **The backend is deployment configuration, not a setting.** Which GPU the
  container can reach is fixed by the compose file, so a UI choice could only
  agree with it or fail. The web UI still composes `<codec>_vaapi` for
  "hardware"; the sidecar maps that onto its own backend (`forThisHost`) and
  reports the backend in `/capabilities`, which the settings page uses to dim
  the device field and mark VP8/VP9 as having no GPU support. VP9 on NVENC
  maps to `vp9_nvenc`, which nothing registers; the sidecar resolves an
  unregistered key to the same codec's software profile, where it used to
  answer with its default and turn VP9 into VP8. Nor does it probe the other
  vendor's encoders, which are never passed through.
- **Deployment is an override file**, `docker-compose.nvidia.yml`, which also
  sets `SIDECAR_HW_BACKEND=nvenc`: the GPU reservation makes Compose refuse to start on a host without the NVIDIA
  runtime, so it cannot live in the main compose files. The image is
  unchanged — Debian's FFmpeg 5.1 already has `h264_nvenc` and loads the
  driver libraries the NVIDIA Container Toolkit mounts in (capability
  `video`).

Verified end to end on an RTX 5080 under WSL2: the test stack
(`docker-compose.test.yml` + `docker-compose.nvidia.yml`) against a
TeamSpeak 6 server (6.0.0-beta13.1) and the Windows client. A 4K VP9 YouTube
source decoded with NVDEC and encoded with `h264_nvenc` as Constrained High,
which the client decoded (`h264_cuvid`) with no loss; GPU load rose from 2 %
to 9 % while CPU stayed low. The settings page dims the device field and
marks VP8/VP9 as having no GPU support, VP9 with hardware on falls back to
`vp9_software`, and without the override the sidecar reports `vaapi` and
probes no NVENC encoder. The full results are on PR #12.

### Viewers waited five seconds to join

The sidecar answers a viewer's join request only once ICE gathering has
completed, and gathering completes only when every STUN request has been
answered or has timed out. pion's STUN timeout is five seconds, and the list
has nine servers; one that does not answer held every viewer at "waiting to
be let in" for exactly five seconds. Reproduced locally with an address that
never answers: 5.0 s to create a peer, 1.0 s with the timeout set to one
second, which is what `stunGatherTimeout` now is. A reachable STUN server
answers in a fraction of that, so the server-reflexive candidates remote
viewers need are kept.

### Images published to GHCR

`.github/workflows/publish.yml` builds the three images on every push and
pushes them to `ghcr.io/korppujauho/ts6-manager-{backend,frontend,sidecar}`,
tagged by branch, by commit SHA, and `latest` on the default branch.
`docker-compose.ghcr.yml` runs them.

Upstream has no equivalent. Its `docker-compose.hub.yml` pointed at
`clusterzx/ts6-manager:*`, so a deployment using it ran **upstream's** code,
not this fork's; it was kept at first and has since been removed (see
"Smaller changes").

The motive is that building on the deployment host has failed twice in ways CI
could not reproduce: a `cpu-features` toolchain error, and the umask problem
under "Second deploy" above. Both were properties of the host, not the commit.
Pulling an image CI already built removes the host's toolchain from the
deployment path entirely.

CI's own Docker job now reads the same build cache (`cache-from`, read-only —
both workflows writing one scope would evict each other). The cache scope is
keyed on the *Dockerfile* name because that is what CI's matrix carries; the
two must agree or neither reuses the other's layers.

The publish half is verified: the workflow's first run built and pushed all
three images, and all three manifests are readable from GHCR with an
anonymously-obtained token, so a deployment needs no `docker login`. That
corrects an expectation written into the first draft of this section —
packages inherit the *repository's* visibility rather than defaulting to
private.

What remains unverified is the other half: nothing here has run a container
from one of these images.

### A failed stream start cleaned up nothing

Seen on the local test rig: a `!stream` given a second after `!stopstream`
got no answer to its `setupstream`, nor did the two retries after it, and
three minutes later a stream started with every join request handled four
times.

The four was a leak. Each start attaches a fresh `StreamSignaling` to the
client, and only `stopVideoStream()` detached it — which returns at once when
no stream got as far as running. A start that failed at `setupstream` left its
listener attached for good, so three failures meant three extra answers to
every later join request. `startVideoStream()` now undoes whatever a failed
start set up: the signaling, a locally spawned sidecar, or — once the server
has announced the stream — the stream itself, through a full stop. A second
start while one is still waiting for the server is refused rather than
building its signaling over the first's.

Why the server did not answer was invisible, because the answer was being
dropped. The client protocol's replies are all `error` lines, and the stream
code listened only for `notify*` commands, so a refused `setupstream` looked
exactly like no reply at all. `setupstream` now carries a `return_code`,
which the TS6 server echoes (checked against 6.0.0-beta13.1: `error id=0
msg=ok return_code=…` after the `notifystreamstarted`, and the code comes back
on errors too). A refusal fails the start at once with the server's own
message, in the log and in the bot's chat reply; silence still ends in the
ten-second timeout, which now says so in the log as well.

**Commands that overlap a start or a stop.** Both take seconds — a stop waits
a second for its `stopstream` to be acknowledged — and commands arrive in
between. A `!stream` 0.7 s after `!stopstream` found the bot still marked as
streaming and was taken as a source change: it resolved the new URL,
restarted FFmpeg for a stream the server had already ended, and put the
streaming nickname back after the stop had reset it, where it stayed. The
reverse was answered "no active stream" while the start went on to run
unstopped. Now a stream being stopped no longer counts as streaming, and a
start waits for the stop to finish; a stop given during a start waits for it
and stops what it produces; two stops share one teardown; and a source change
checks the stream is still the one it began on before touching the sidecar or
the nickname.

**The cause: the server's flood protection.** With the reply logged, the next
fast restart named it — `setupstream refused by the server: client is
flooding (error 524)`. At the server defaults (`virtualserver_antiflood_*`:
block at 150 points, 5 shed a second) a start, a stop and a start inside
three seconds, with the bot's chat replies, is enough. Every command a blocked
client sends is refused and adds points, so each retry — and each chat reply
explaining the failure — pushed the end of the block back, which is how it
lasted minutes. Two changes:

- A start sent five commands, three of them `servernotifyregister` repeating
  registrations that last for the whole connection. They are now sent once
  per connection, and again after a reconnect.
- An error 524 from any command starts a 30 s hold, restarted by each further
  524. During it the bot sets every chat command aside and sends nothing —
  no action, no reply, no now-playing line — and a reply a command would make
  after tripping the block part-way is dropped too. When the hold has passed
  it says once that commands came too fast and were ignored, however many
  were set aside. The first version held only `!stream` and `!tv` and still
  answered `!stopstream`, which looked like the bot ignoring one command
  while answering the next — and every such answer was refused and prolonged
  the block.

Measured on the test server with a throwaway client: 9 `clientupdate`s were
accepted before the first 524, so a command costs roughly 15–17 of the 150
points, and a client that keeps sending while blocked stays blocked — probing
every half second held it past 60 s, and 35 s of silence after that was not
enough. A bot's whole start-watch-stop cycle is about that budget, which is
why the block could also trip at an unhurried pace. It stays rare in normal
use; the hold makes sure the bot does not make it worse, and the message
tells whoever was typing why nothing happened.

### The first stream after a codec change was black

Seen in production and on the test rig alike: after changing the codec in
Settings → Streaming, or after the sidecar restarted, the first stream
showed black — the client received packets at full rate, but reported
`0x0 0fps` and no decoder. Stopping and starting again always worked.

The start announced the stream (`setupstream`) before it gave the sidecar
its source. A viewer's client asks to join the moment the stream is
announced, and the sidecar builds that viewer's peer — the codec in its SDP
and, for H.264, the level derived from the frame size — from the profile of
the *last* source it was given. The new source arrived a second or so later,
so the first stream negotiated the previous codec (or, after a restart, the
default one) and carried the new one. The second stream worked because by
then the previous profile was the right one. This is the "three places must
agree" failure from the VP9 section, reached through ordering rather than
code.

The start now resolves and probes the source, hands it to the sidecar, and
only then announces the stream, so no peer can exist before the profile it
needs. A source that fails to resolve no longer leaves an announced stream
behind, and a stream the server refuses stops the encoder it started.

The reorder opens no extra connection to the source, which matters for an
IPTV service that allows only one. Viewers receive from the sidecar, never
from the source; with a named preset FFmpeg's is still the only connection
(the frame size comes from the preset, so nothing is probed), and with Auto
the probe still opens and closes its own before FFmpeg opens its — only the
announcement moved, to after both.

### Software VP8 and VP9 now run at constant bitrate

A VP9 software stream at 4K was reported by the client at 25 Mbit/s with
3 % packet loss, against a 9.5 Mbit/s preset. libvpx treats `-maxrate` as a
hint: it stays in variable-bitrate mode unless `-minrate` equals the target
too. x264, VAAPI and NVENC hold `-maxrate` on their own, so only the two
libvpx profiles were affected. `EncoderProfile.rateArgs` now adds `-minrate`
for them.

Measured with the sidecar image's FFmpeg and the exact stream flags:

| Source | Target | Before | With `-minrate` |
|---|---|---|---|
| 1080p, detailed (noise) | VP8 5500k | 6.2 Mbit/s | 5.5 |
| 1080p, detailed (noise) | VP9 5500k | 10.4 | 7.3 |
| 1080p, plain | VP9 5500k | 3.8 (budget unspent) | 5.5 |
| 4K YouTube video, 8 s | VP9 9500k | 13.4 | 12.8 |

That last row is the limit of this fix. On detailed 4K video libvpx at
`-cpu-used 8` still runs about a third over, and not because it cannot go
lower — pinned at its coarsest quantizer the same clip needs 0.5 Mbit/s. The
larger share is keyframes: `-g 30` puts one every second, and on that clip
they are 19 % of the bits at 2.5 Mbit each, a quarter of a second's budget in
one frame and a burst on the wire. At `-g 300` the same stream comes to
10.4 Mbit/s. The one-second interval is deliberate — FFmpeg cannot be asked
for a keyframe, so it is what bounds how long a new viewer waits for a
picture. **Decided: kept at one second.** With `-minrate` a 4K VP9 stream
was measured in the client at about 10 Mbit/s, peaking near 13.5, with no
packet loss; a longer wait for joining viewers is not worth the rest.

### Which errors end a connection

The client and the bot treated three error ids as "the server refused us,
do not reconnect", commented as 2568 invalid password, 3329 banned, 1796
max clients. Each case was provoked on the TeamSpeak 6 test server
(6.0.0-beta13.1) — a server password set, the slot count lowered, a ban
added, each undone straight after — and only 3329 was right:

| Case | Error the server sends |
|---|---|
| A command the client may not run | 2568 insufficient client permissions |
| Wrong server password | 1028 invalid server password |
| Server full | 1027 server maxclient reached |
| Banned | 3329 connection failed, you are banned |

So one command the bot was not permitted — a `setupstream`, for instance —
disconnected it for good, while a wrong password or a full server went
unrecognised: the connect waited out its fifteen-second timeout and the
manager retried, ten times over. 1796 never appeared.

`CONNECTION_REFUSED_ERRORS` in `tslib/client.ts` now holds 1027, 1028 and
3329, and the bot reads the same set. A refused connection fails at once
with the server's reason; 2568 is the error of the one command that drew it.

## Fixes to coom's changes (fork only)

This fork builds on [coom/ts6-manager](https://github.com/coom/ts6-manager),
not on upstream directly. The entries here fix problems that coom's own
changes introduced. Upstream clusterzx does not have them, and they are not
suggestions for other forks.

### One ServerQuery session per server, shared

Flows with event or command triggers stopped firing after coom's changes.
Webhook and cron triggers kept working. The cause was the number of SSH
ServerQuery sessions the backend opened to the same server:

- the flow engine's own session;
- one more from the connection journal (coom 7814d4a), which built its own
  `EventBridge`;
- one more from the Discord bridge's presence events (coom 75b961c),
  deliberately separate because the engine closed sessions its flows no
  longer used.

They all log in as the same user from the same IP, and TeamSpeak's
anti-flood counts them against one allowance. On the TS6 test server,
running just the engine and the journal produced 14 `524 client is
flooding` errors. Event registrations failed, and the keepalive `whoami`s
failed, which forced a disconnect. The server then refused the reconnect
("Connection lost before handshake"). The engine's session was dead within
about 90 seconds. With the journal's session removed, the same run had no
errors.

`EventBridge` now tracks who holds each server:sid session. The engine, the
journal and the Discord bridge each `acquire` it under their own name, and
it closes only when the last holder calls `release`. The file browser still
opens a session on demand without holding it. Each consumer listens on the
shared bridge and filters out events that are not its own: other servers,
other virtual servers, and the engine's per-channel command listeners.

Four gaps in `SshQueryClient` had turned a temporary flood into a session
that stayed dead until restart:

- A 524 reply to a keepalive counted as a failed keepalive; now only an
  unanswered one does.
- A failed connect never tried again, because only a session that had been
  up reconnected. Now every non-fatal failure backs off (1 s, doubling to
  30 s) and retries.
- Event registration gave up on a 524. It now waits and retries (3 s, 6 s,
  12 s), and logs the event types that still failed.
- Concurrent connects could open duplicate sessions.

Command triggers bound to a channel still need one extra session per
channel, because TeamSpeak only delivers channel chat to a query client
sitting in that channel.

Closing a session now sends ServerQuery `quit` first. Without it, TeamSpeak
6 left the socket in CLOSE_WAIT and kept listing the query client. On the
test server, the listener of a disabled flow was still there minutes after
the backend had closed its end.

**TeamSpeak 6's query flood limit is tight, and it bans.** A stock server
reports:

| Setting | Value |
|---|---|
| `serverinstance_serverquery_flood_commands` | 10 per `flood_time` of 3 s |
| `serverinstance_serverquery_ban_time` | 600 s |
| `serverinstance_serverquery_max_connections_per_ip` | 5 |

The limit is counted per IP, across every SSH session and the manager's
WebQuery calls together. Live testing hit it three ways, and each has a fix:

- **A burst of registrations.** Reopening the main session and a command
  listener together (as "Forget SSH host key" does) meant about a dozen
  registration commands in a second, on top of the UI's WebQuery calls.
  A `QueryPacer` per server now gives all its SSH sessions 5 commands per
  3 s between them, and a command's timeout starts only when it is written.
- **Every Save in the flow editor.** Saving disabled and re-enabled the
  flow, which closed and reopened its command listener: a new login and
  five commands each time. `reloadFlow` now swaps the flow in place and
  keeps its sessions.
- **Retrying during the ban.** The ban shows up as connections dropped
  before the SSH handshake, and every attempt during it restarted the
  600 s. Retrying every 30 s kept the manager banned for good. After such a
  drop, the next attempt now waits 610 s. With the backend's IP silent for
  10.5 minutes, the next start connected on the first try.

A registration that still fails is retried every 60 s until it succeeds.
Before, a session whose registration fell inside a ban stayed connected but
deaf until the backend restarted.

### Resetting the SSH host-key pin

coom 91a483f pins the server's SSH host key on first use, and nothing ever
cleared the pin. A server reinstalled at the same address, or a connection
edited to point elsewhere, was refused for good. Now the pin is cleared when
a connection's host or SSH port changes. Settings → Connections → Edit also
has **Forget SSH host key** for the same-address case. Either action, like
any SSH credential change, reopens that server's sessions straight away.
Saving the form with the SSH fields unchanged does not.
A key that changes on its own is still refused, as a fatal error with no
retry loop, and the log names the fix.

## Open follow-ups

1. VP9 keyframe detector, to restore the per-peer stream gate for VP9. (VP8
   streams gate correctly again.) Note that FFmpeg's VP9 RTP packetizer is not
   known to set the descriptor's P bit, so "P clear means keyframe" needs
   checking against a real capture before it can be relied on; gating on the B
   bit alone would at least align the gate to a frame start.
2. The source decoder's frame threading: about half a second of video delay
   on a many-core host, a quarter on the NAS. With GPU decoding, limiting it
   should cost little; with CPU decoding of a 4K source one thread may not
   keep up, so it needs measuring before a default changes.
3. An H.264 parameter-set detector, so a peer joining mid-stream is held until
   an SPS rather than opening on the first packet. The same gap VP9 has; less
   pressing than it looks, because the PLI interceptor asks for a keyframe and
   the parameter sets are repeated at every one.
4. **Exempting the bot from flood protection.** The server has a permission
   for it, `b_client_ignore_antiflood` (present on 6.0.0-beta13.1). Granted to
   the bot's identity or a group it is in, fast stream restarts could not trip
   the block at all. Not done by the manager: it is a property of each
   server's permission setup, which the manager cannot assume it may change,
   and an exempt client can also flood the server itself. An operator who
   wants it can grant it in TeamSpeak.
