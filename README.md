![AI Assisted](https://img.shields.io/badge/AI%20Assisted-Project-00ADD8?style=for-the-badge&logo=dependabot&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

# TS6 Manager

Web-based management interface for TeamSpeak servers: virtual servers,
channels, clients, permissions, music bots, video streaming, automated
workflows and embeddable server widgets, from the browser. Built on the
**WebQuery HTTP API**; telnet ServerQuery is not used.

This repository is a fork. Its lineage:

1. [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager), the
   original.
2. `coom/ts6-manager`, a hardened fork of it: MFA and SSO, the Discord bridge, the
   connection journal, five UI languages, and the music bot's streamed playback
   and native Opus encoder.
3. **This fork**, below.

## What this fork changes

Mostly video streaming and the music bot. The reasons behind each change,
and what to preserve when merging upstream, are in
[`docs/fork-changes.md`](docs/fork-changes.md).

**Video streaming**
- **Hardware encoding** on Intel and AMD (VAAPI) or NVIDIA (NVENC, H.264),
  configured in Settings → Streaming: GPU, encoder, device, on/off. The UI probes the sidecar
  and greys out encoders the host cannot run; one that fails falls back to
  software instead of failing the stream.
- **VP8, VP9 and H.264**, software or hardware. H.264 is sent as Constrained
  High, the only H.264 profile the TeamSpeak client decodes, which it can
  decode on the viewer's GPU.
- **1080p and above from YouTube**: separate video and audio (DASH) streams,
  since YouTube's combined formats stop at 720p.
- **Auto quality**, the default: the stream follows the source's resolution,
  so a 720p channel is not upscaled, up to a configurable limit (4K unless
  lowered). Or a fixed preset, up to 2160p.
- **The GPU decodes the source as well as encoding it**, where it supports the
  source's codec; otherwise decoding falls back to the CPU.
- **Idle streams stop themselves** after five minutes with no viewers.
- Several fixes to streams that negotiated and then showed a black picture
  (keyframe gate, ICE candidates, codec mismatches).

**Music bot**
- **Live TV:** `!tv` streams channels from an M3U/M3U8 playlist, with loose
  name matching (`!tv mtv3` finds "MTV 3"). The playlist, a channel filter and
  the order are set in the UI.
- **Bot language:** replies in English, Finnish, French, German, Spanish or
  Italian, chosen separately from the UI language.
- The bot's nickname shows what it is streaming (`Boten Anna - Streaming 'MTV3'`).
- Radio stations are listed by id, the number `!radio <id>` takes.

**Deployment**
- **Prebuilt images** on GHCR for every branch and commit
  ([`docker-compose.ghcr.yml`](docker-compose.ghcr.yml)); building from source
  is still the default.
- [`docs/deploying.md`](docs/deploying.md): moving a deployment onto a git
  checkout, upgrading, rolling back, and deploying a branch.
- [`docs/local-testing.md`](docs/local-testing.md): a local TeamSpeak server to
  test against.

## Screenshots

| Dashboard | Music bots |
|---|---|
| ![Dashboard](docs/dashboard.png) | ![Music Bots](docs/musicbots.png) |
| **Flow editor** | **Flow templates** |
| ![Flow Editor](docs/flow-editor.png) | ![Flow Templates](docs/flow-templates.png) |

## Features

**Server management.** Dashboard with live stats and bandwidth graph; virtual
servers; channel tree with drag-and-drop; clients (kick, ban, move, poke);
server and channel groups; permission editor; bans, tokens, complaints,
offline messages; server log; channel file browser.

**Music bots.** Several per server, each with its own queue: radio streams with
live titles, YouTube via yt-dlp, Spotify links resolved to YouTube, a local
library with playlists. Controlled from the UI or by text commands in the
bot's channel (below), and can be limited to chosen server groups.

**Video streaming.** YouTube, Twitch, direct URLs and IPTV into a TeamSpeak
channel over WebRTC, through a Go sidecar (Pion) that drives FFmpeg.

**Discord bridge.** Slash commands (`/play`, `/skip`, `/queue`, …), TeamSpeak
join/leave and AFK notices, a live server-stats panel, the bot's audio in a
Discord voice channel, and commands limited to chosen roles.

**Bot flow engine.** A visual editor for automations: triggers (TeamSpeak
events, cron, webhooks, chat commands, Discord messages), conditions and
actions, with ready-made templates (temporary channels, AFK mover, idle
kicker, …).

**Accounts and security.** Setup wizard (no default credentials); TOTP MFA
with recovery codes, enforceable per user; trusted devices; password policy;
optional [SAML SSO](docs/sso-saml.md); admin and viewer roles with per-server
access. Credentials are stored AES-256-GCM encrypted; outbound requests are
SSRF-guarded; JWTs rotate with reuse detection.

**Also:** a connection journal of web and TeamSpeak logins with offline GeoIP
and one-click IP bans; embeddable server widgets (page, SVG or PNG); a UI in
English, French, German, Spanish and Italian.

## Quick start (Docker)

1. Clone the repository and create `.env` at its root:

   ```bash
   echo "JWT_SECRET=$(openssl rand -base64 32)" >> .env
   echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
   echo "SIDECAR_TOKEN=$(openssl rand -base64 32)" >> .env
   ```

   All three are required. `ENCRYPTION_KEY` encrypts stored credentials:
   back it up, and never regenerate it on an existing install, or every saved
   credential becomes unreadable.

2. Start the stack, either built from source or from CI's images:

   ```bash
   docker compose up -d --build                    # build on this host
   docker compose -f docker-compose.ghcr.yml up -d # pull prebuilt images
   ```

3. Open `http://localhost:3000/setup`, create the admin account, then add the
   TeamSpeak server under **Settings → Connections** (host, WebQuery port, API
   key).

**Hardware encoding** works on Intel and AMD GPUs through VAAPI. AMD
hardware has no VP9 encoder, so on AMD choose H.264; VP9 there falls back to
software. The GPU has to be passed through to the sidecar container, with its
unprivileged user in the group that owns the render node. Both are set up in
`docker-compose.yml`; `RENDER_GID` in `.env` overrides the group. Then turn it
on under Settings → Streaming.

**NVIDIA** GPUs encode H.264 through NVENC. The host needs the NVIDIA driver
and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html);
then add the override file and choose GPU → NVIDIA, codec H.264:

```bash
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d
docker compose -f docker-compose.ghcr.yml -f docker-compose.nvidia.yml up -d   # prebuilt
```

`docker-compose.hub.yml` runs clusterzx's Docker Hub images, which contain
none of this fork's changes, and uses different internal ports, so never mix
it with the other compose files.

## Configuration

Most settings (encoder, GPU device, presets, IPTV, bot language, Discord,
Spotify, SSO) are in the web UI. The encoder and GPU device are not
environment variables: the sidecar is long-lived in Docker and its environment
is fixed at container start, so they travel with each stream instead.

**Backend**

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | — | **Required.** JWT signing secret. |
| `ENCRYPTION_KEY` | — | **Required in production**, must differ from `JWT_SECRET`. Encrypts stored credentials. |
| `SIDECAR_TOKEN` | — | Shared secret for the sidecar API. The sidecar refuses to start without it. |
| `SIDECAR_URL` | — | Sidecar address when it runs as its own container (e.g. `http://ts6-sidecar:9800`). |
| `FRONTEND_URL` | `http://localhost:3000` | Public origin: CORS, and the base of the SAML URLs. |
| `PORT` | `3001` | Backend port. |
| `DATABASE_URL` | `file:./data/ts6webui.db` | SQLite path. |
| `JWT_ACCESS_EXPIRY` / `JWT_REFRESH_EXPIRY` | `15m` / `7d` | Token lifetimes. |
| `MUSIC_DIR` | `/data/music` | Downloaded music. |
| `YT_COOKIE_FILE` | — | Netscape cookies.txt for yt-dlp; also settable in Settings → YouTube. |

**Sidecar**

| Variable | Default | Description |
|---|---|---|
| `SIDECAR_LISTEN_ADDR` | `127.0.0.1` | API interface (`0.0.0.0` inside Docker, set by the image). Never publish port 9800. |
| `SIDECAR_H264_PROFILE` | `constrained_high` | H.264 profile. The others (`constrained_baseline`, `main`, `high`) do not play in the TeamSpeak client; they exist for testing. |
| `SIDECAR_HW_DECODE` | on | With hardware encoding, also decode the source on the GPU. `0` decodes on the CPU. |
| `SIDECAR_DEBUG_LOGS` | off | `1` logs per-packet detail and the full SDP offer and answer. Leave off: an SDP carries ICE credentials and host addresses. |
| `STUN_SERVERS` | — | Comma-separated STUN URLs. |
| `VIDEO_QUEUE_SIZE` / `AUDIO_QUEUE_SIZE` | `1024` / `2048` | RTP queue lengths. |
| `VIDEO_RTP_READ_BUFFER` / `AUDIO_RTP_READ_BUFFER` | 4 MiB / 1 MiB | UDP socket buffers. |
| `AUDIO_BITRATE` | `128k` | Opus bitrate. |
| `AUDIO_DELAY_MS` | `0` | Delays the stream's audio by this much, to correct a source whose audio runs ahead. |

## Music bot text commands

| Command | Description |
|---|---|
| `!play <url>` / `!play` | Play a YouTube URL / resume |
| `!queue <url>` / `!add <url>` | Add to the queue |
| `!spotify <url>` | Play a Spotify track, album or playlist |
| `!radio` / `!radio <id>` | List radio stations / play one |
| `!pause`, `!stop`, `!skip` / `!next`, `!prev` | Playback control |
| `!vol` / `!vol <0-100>` | Show / set volume |
| `!np` / `!nowplaying`, `!info` | Current track, with progress |
| `!lyrics [search]` | Lyrics for the current track or a search |
| `!stream <url> [preset]` | Stream a video to the channel |
| `!tv` / `!tv <channel>` / `!tv reload` | List / start / refetch live TV channels |
| `!stopstream`, `!viewers` | Stop the stream / list its viewers |
| `!channels`, `!help` | List channels / commands |
| `!move <user> <channel>`, `!moveall <channel>`, `!notif` | Admin: move users, toggle now-playing notices |

Access to music and admin commands, and the language the bot replies in, are
set under **Settings → Music Commands**. `!tv` needs a playlist under
**Settings → Streaming**.

## Development

Requires Node.js 20+ and pnpm 9+.

```bash
pnpm install
pnpm --filter @ts6/common run build   # first: the other packages import it
pnpm db:generate                      # Prisma client
pnpm dev                              # backend :3001, frontend :5173
```

The schema is applied with `prisma db push` (the Docker image does it on
start); this fork does not use migrations. `pnpm lint`, `pnpm typecheck` and
`pnpm test` are what CI runs, along with `go build ./...` and `go vet ./...`
in `packages/sidecar`. [`CLAUDE.md`](CLAUDE.md) lists the invariants that are
easy to break.

| Package | What |
|---|---|
| `packages/backend` | Express API, Prisma (SQLite), WebQuery client, voice bots, Discord bridge |
| `packages/frontend` | React, Vite, Tailwind, shadcn/ui, TanStack Query, i18next |
| `packages/common` | Types and constants shared by both |
| `packages/sidecar` | Go WebRTC media relay (Pion); drives FFmpeg |

## Requirements

- A TeamSpeak server with **WebQuery HTTP** enabled, and a WebQuery API key
  (`apikeyadd`)
- SSH access to the server, only for bot-flow event triggers
- `ffmpeg` and `yt-dlp` on the backend (included in the Docker images)

## Troubleshooting

**Lost access to the TeamSpeak server after an update** (invalid API key, SSH
refused, flood bans): a server update most likely expired the API key or reset
the query configuration. See
[Recovering access to your TeamSpeak server](docs/recover-server-access.md).

**Hardware encoding stopped after an upgrade:** from a version that predates
the streaming settings, it is off until re-enabled in Settings → Streaming.
See [`docs/deploying.md`](docs/deploying.md).

## Translations

[Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) ·
[Italiano](README.it.md): these describe `coom/ts6-manager` and do not cover this
fork's changes.

## License

MIT
