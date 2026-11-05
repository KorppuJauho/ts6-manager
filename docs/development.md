# Development

Requires Node.js 20+ and pnpm 9. Go is needed only to work on the sidecar.

```bash
cp .env.example .env                  # then fill in the secrets
cp .env packages/backend/.env         # the Prisma CLI reads DATABASE_URL from here
pnpm install
pnpm --filter @ts6/common run build   # first: the other packages import it
pnpm db:generate                      # Prisma client
pnpm db:push                          # create or update the SQLite schema
pnpm dev                              # backend :3001, frontend :5173
```

A TeamSpeak server to test against, and what a local setup can and cannot
verify, is in [Local testing](local-testing.md).

## Checks

CI runs these; run them before pushing:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit --audit-level high
cd packages/sidecar && go build ./... && go vet ./... && go test ./...
```

CI also builds the three Dockerfiles. [`CLAUDE.md`](../CLAUDE.md) lists the
invariants that are easy to break: the codec record the sidecar's three
codec settings derive from, `SOURCE_SEPARATOR`, why the sidecar never fetches
YouTube itself, and how schema changes are applied.

## Database schema

The schema is applied with `prisma db push`; the Docker image does it on
every start, and this fork does not use migrations. Edit `schema.prisma` and
let the push apply it. A change that drops data is refused by the push, and
the container then stops: such a change needs an upgrade procedure like the
one in [Deploying](deploying.md#upgrading-to-the-bot-only-version).

## Layout

| Package | What |
|---|---|
| `packages/backend` | Express API, Prisma (SQLite), the voice bots (TeamSpeak client, audio, stream control) |
| `packages/frontend` | React, Vite, Tailwind, shadcn/ui, TanStack Query, i18next (English only) |
| `packages/common` | Types shared by both |
| `packages/sidecar` | Go WebRTC media relay (Pion); drives FFmpeg |

Frontend strings live in `packages/frontend/src/i18n/locales/en.json`; the
bot's TeamSpeak replies in `packages/backend/src/voice/bot-i18n/en.ts`.
