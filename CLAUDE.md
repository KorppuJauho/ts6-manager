# CLAUDE.md

Guidance for Claude Code working in this repository.

This is a fork. `docs/fork-changes.md` records every divergence from
upstream ([clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager))
and why — **read it before changing streaming, the sidecar, or bot commands**,
and add an entry when you introduce a new divergence.

## Commands

```bash
pnpm install                 # workspace install (pnpm 9+, Node 20+)
pnpm --filter @ts6/common run build   # REQUIRED FIRST: backend/frontend import it
pnpm db:generate             # regenerate the Prisma client after schema edits

pnpm dev                     # backend + frontend in parallel
pnpm lint                    # eslint
pnpm typecheck               # tsc --noEmit, all packages
pnpm test                    # vitest, all packages
pnpm build                   # all packages

cd packages/sidecar && go build ./... && go vet ./...
```

A local TeamSpeak server to test against, and what a local rig can and cannot
verify (VAAPI cannot be tested under WSL2): `docs/local-testing.md`.
Moving a deployment onto a git checkout, backing up before an upgrade, and the
one-off procedure for a schema change that drops data: `docs/deploying.md`.

**`@ts6/common` must be built before typechecking.** Skipping it produces a
cascade of `Cannot find module '@ts6/common'` errors that look like broken
imports but are just a missing build.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, test, build,
`pnpm audit --audit-level high`, the Go build and vet, and builds all three
Dockerfiles. Run the equivalent locally before pushing.

## Layout

| Package | What |
|---|---|
| `packages/backend` | Express REST API, Prisma (SQLite), sign-in and users, the voice bots (`src/voice/`: own TS3 voice client in `tslib/`, music, radio, IPTV, playlists, lyrics, streaming) |
| `packages/frontend` | React + Vite + Tailwind + shadcn/ui, TanStack Query, i18next; polls the REST API (there is no WebSocket) |
| `packages/common` | Types and constants shared by both |
| `packages/sidecar` | Go WebRTC media relay; drives FFmpeg, talks RTP to TeamSpeak |

The manager does not administer TeamSpeak servers. A server record is a name
and a host (Settings -> Servers) that bots connect to as ordinary clients;
there is no ServerQuery, WebQuery or SSH connection. What was removed from
upstream, and why, is in `docs/fork-changes.md`.

## Things that will bite you

**Schema changes go through `prisma db push`, not migrations.**
`Dockerfile.backend` runs `prisma db push` on container start, and the app
starts only if the push succeeds. The committed `prisma/migrations/`
directory is a single one-off patch, not a replayable history — do not add
migration files, and do not run `prisma migrate dev`, which offers to reset a
db push database (the root script is `pnpm db:push`). Edit `schema.prisma` and
let db push apply it.

A change that drops data (a removed table or column, or a column SQLite must
rebuild the table for) is refused without `--accept-data-loss`. The container
start does not pass that flag on purpose: the push fails, the container exits
with Prisma's data-loss warning in the log, and the new build never runs
against the old tables. Such a change needs the one-off backup and
`--accept-data-loss` procedure in `docs/deploying.md`; say so in the commit
message. `prisma/table-counts.mjs` (shipped in the image) prints row counts
plus SQLite's `integrity_check` and `foreign_key_check` for the before/after
comparison, and `prisma migrate diff --from-url "$DATABASE_URL"
--to-schema-datamodel prisma/schema.prisma --script` shows the SQL a push
would run without running it.

**The video codec appears in three places that must agree.** In
`packages/sidecar/main.go`: `MediaEngine.RegisterCodec` (SDP), the
`NewTrackLocalStaticRTP` capability, and FFmpeg's `-payload_type`. Change one
and the stream negotiates one format while carrying another — which fails
silently, as a black or frozen video. All three derive from one record in
`encoders.go` via `videoCodec()`; keep it that way. For H.264 the fmtp line is
part of that identity too — built by `FmtpFor` from the frame size, because
the advertised level has to cover the stream sent — and its encoder arguments
must keep the in-band SPS/PPS bitstream filter. The H.264 profile is
selectable (`SIDECAR_H264_PROFILE`); `-profile:v` and the profile-level-id
prefix must come from the same `h264Profiles` entry, via `encodeArgs` and
`FmtpFor`. The default is Constrained High (`640c`), the only H.264 profile
the TeamSpeak client decodes — Constrained Baseline negotiates and renders
black. Get any of this wrong and the stream connects, counts packets, and
shows nothing.

**`SOURCE_SEPARATOR` is a wire format between two processes.** A DASH source
is video and audio URLs joined by `|||`: declared in
`voice/streaming/types.ts` and as `sourceSeparator` in `sidecar/main.go`.
Change both together. `validSource` validates each segment separately —
preserve that loop, it is what stops a source smuggling an FFmpeg argument.

**The sidecar runs two ways.** Spawned as a child process locally (config via
env at spawn), or as a long-lived container in Docker (`SIDECAR_URL` set).
In container mode env is fixed at container start, so **anything
per-stream must travel in the `POST /source` body**, never an env var.

**Hardware encoding needs more than the Dockerfile.** VAAPI needs `/dev/dri`
passed through *and* the unprivileged `sidecar` user in the group owning the
render node. See the comments in `docker-compose.yml`. NVIDIA needs the NVIDIA
Container Toolkit on the host and `docker-compose.nvidia.yml` layered on top
(it also sets `SIDECAR_HW_BACKEND=nvenc`, which is what points hardware
encoding at NVENC — deployment config, deliberately not a UI setting);
that override cannot move into the main compose files, because Compose refuses
to start without the NVIDIA runtime. NVENC encodes H.264 only, and must be fed
4:2:0 — given RGB it silently encodes High 4:4:4, which TeamSpeak cannot decode.

## Conventions

- **Comments explain why, not what.** The codebase documents reasoning and
  non-obvious constraints; it does not narrate the code. Match that.
- **English only.** Comments, the web UI and the bot's replies are in
  English; there is no language setting. The bot's TeamSpeak replies come
  from `voice/bot-i18n/en.ts`, not string literals.
- **Frontend strings go through i18next** (`src/i18n/locales/en.json`, the
  only locale). Never hardcode display text in a component.
- Commit messages: conventional-commit subject, then a body explaining the
  reasoning and any trade-off carried. Look at recent history for the register.
- **Do not put personal identity in the history.** Commit as
  `korppujauho <130571566+KorppuJauho@users.noreply.github.com>`, never a
  personal address — this is a public repository and commit metadata is
  permanent. Do not add `Claude-Session:` trailers or session links to commit
  messages or pull request descriptions; `Co-Authored-By: Claude` is the
  disclosure the maintainer wants, and it is enough.
- Tests are vitest, colocated as `*.test.ts`. Cover the cases real input
  hits, not just the happy path.

## Security

This project handles user sessions (password sign-in with admin and viewer
roles, the password policy, login rate limits), Spotify credentials and the
bots' TeamSpeak identities. It holds no ServerQuery credentials and no SSO
config. Several guards exist because of specific past vulnerabilities and are
easy to remove by accident:

- `assertSafeUrl` / `validateUrl` guard SSRF on anything fetched from a URL a
  user supplied. `validateUrl` refuses private addresses — which is why the
  IPTV playlist, an operator-supplied LAN address, deliberately does not use
  it and enforces scheme, timeout and a size cap instead.
- yt-dlp calls reject URLs starting with `-` and place a literal `--` before
  the positional argument.
- The sidecar's HTTP API requires a bearer token and refuses to start without
  one.
- `authMiddleware` accepts only tokens with `typ: 'access'`, so the
  short-lived forced-password-change token cannot be used as a session.
- Bot identities and the Spotify client secret are stored encrypted
  (`utils/crypto.ts`); do not write them to the database or a log in clear.
- `requireServerAccess` scopes viewers to the servers an admin granted them
  under Settings -> Users; routes taking a server id must keep it.

When a change touches any of these, say in the commit message why it is still
safe.
