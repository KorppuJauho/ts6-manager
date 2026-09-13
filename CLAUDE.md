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

**`@ts6/common` must be built before typechecking.** Skipping it produces a
cascade of `Cannot find module '@ts6/common'` errors that look like broken
imports but are just a missing build.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, test, build,
`pnpm audit --audit-level high`, the Go build and vet, and builds all three
Dockerfiles. Run the equivalent locally before pushing.

## Layout

| Package | What |
|---|---|
| `packages/backend` | Express API, Prisma, TeamSpeak client, voice bots, Discord bridge |
| `packages/frontend` | React + Vite + Tailwind + shadcn/ui, TanStack Query, i18next |
| `packages/common` | Types and constants shared by both |
| `packages/sidecar` | Go WebRTC media relay; drives FFmpeg, talks RTP to TeamSpeak |

## Things that will bite you

**Schema changes go through `prisma db push`, not migrations.**
`Dockerfile.backend` runs `prisma db push` on container start. The committed
`prisma/migrations/` directory is a single one-off patch, not a replayable
history — `prisma migrate diff` cannot even replay it. Do not add migration
files; edit `schema.prisma` and let db push apply it.

**The video codec appears in three places that must agree.** In
`packages/sidecar/main.go`: `MediaEngine.RegisterCodec` (SDP), the
`NewTrackLocalStaticRTP` capability, and FFmpeg's `-payload_type`. Change one
and the stream negotiates one format while carrying another — which fails
silently, as a black or frozen video.

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
render node. See the comments in `docker-compose.yml`.

## Conventions

- **Comments explain why, not what.** The codebase documents reasoning and
  non-obvious constraints; it does not narrate the code. Match that.
- **Write comments and user-facing strings in English.** The bot's TeamSpeak
  replies come from `voice/bot-i18n/`, not string literals.
- **Frontend strings go through i18next** (`src/i18n/locales/*.json`), all
  five languages. Never hardcode display text in a component.
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

This project handles TeamSpeak ServerQuery credentials, SAML config and user
sessions. Several guards exist because of specific past vulnerabilities and
are easy to remove by accident:

- `assertSafeUrl` / `validateUrl` guard SSRF on anything fetched from a URL a
  user supplied. `validateUrl` refuses private addresses — which is why the
  IPTV playlist, an operator-supplied LAN address, deliberately does not use
  it and enforces scheme, timeout and a size cap instead.
- yt-dlp calls reject URLs starting with `-` and place a literal `--` before
  the positional argument.
- The sidecar's HTTP API requires a bearer token and refuses to start without
  one.

When a change touches any of these, say in the commit message why it is still
safe.
