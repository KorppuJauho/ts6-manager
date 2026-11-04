![AI Assisted](https://img.shields.io/badge/AI%20Assisted-Project-00ADD8?style=for-the-badge&logo=dependabot&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

# TS6 Manager

A web interface for running music and video bots on TeamSpeak 6 servers:
music bots with queues, radio, a music library and playlists, and video
streams (YouTube, Twitch, direct URLs, live TV) into a channel. Each bot joins
the server as an ordinary client, over its own voice connection, so the
manager needs no query interface: no WebQuery, no API key, no SSH.

This repository is a fork. Its lineage:

1. [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager), the
   original: server management over the WebQuery HTTP API, music bots, bot
   flows and server widgets.
2. `coom/ts6-manager`, a hardened fork of it: MFA and SSO, the Discord bridge,
   the connection journal, five UI languages, and the music bot's streamed
   playback and native Opus encoder.
3. **This fork**, below.

This fork has since removed most of what the first two built around the bot:
server management and WebQuery, bot flows and SSH ServerQuery, server widgets,
the Discord bridge, the connection journal, MFA, trusted devices, SAML SSO,
web bans, every UI and bot language but English, and the native Opus encoder.
It is run for its bot, and each of those either needed a query session or an
outside service, or went unused. The streamed playback stays. The history of
each change is in [`docs/fork-changes.md`](docs/fork-changes.md).

## What this fork changes

Mostly video streaming and the music bot. The reasons behind each change,
and what to preserve when merging upstream, are in
[`docs/fork-changes.md`](docs/fork-changes.md).

**Bot only**
- The manager no longer administers TeamSpeak servers. A server record is a
  name and a host, which the bots connect to; the voice port is set per bot.
- The removed features and their database tables are gone, not just hidden.
  Upgrading an older install needs a backup and a one-off schema push; see
  [Upgrading to the bot-only version](#upgrading-to-the-bot-only-version).
- English only, in the web UI and in the bot's replies.
- Viewers see the Music Request History of the servers an admin grants them,
  and their own account settings.

**Video streaming**
- **Hardware encoding** on Intel and AMD (VAAPI) or NVIDIA (NVENC, H.264),
  configured in Settings → Streaming: encoder, GPU device, on/off. Which GPU
  is set by the compose file that passes it through. The UI probes the sidecar
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
- The bot's nickname shows what it is streaming (`Boten Anna - Streaming 'MTV3'`).
- **Bot avatars:** upload one (PNG, JPEG or GIF up to 200 KB, shrunk to fit
  300×300 for TeamSpeak), use the app icon, or none.
- Radio stations are listed by id, the number `!radio <id>` takes.
- Audio is encoded by opusscript (libopus as WebAssembly) only; the native
  Opus module, with its install-time binary download, is gone. opusscript
  measured about 1.5× its CPU, not the 5–10× once claimed, and is warmed up
  at start so the first song does not stutter.

**Deployment**
- **Prebuilt images** on GHCR for every branch and commit
  ([`docker-compose.ghcr.yml`](docker-compose.ghcr.yml)); building from source
  is still the default.
- [`docs/deploying.md`](docs/deploying.md): moving a deployment onto a git
  checkout, upgrading, rolling back, and deploying a branch.
- [`docs/local-testing.md`](docs/local-testing.md): a local TeamSpeak server to
  test against.

## Features

**Music bots.** Several per server, each with its own queue: radio streams with
live titles, YouTube via yt-dlp, Spotify links resolved to YouTube, and a local
library with uploads, downloads and playlists (a YouTube playlist can be
imported into one). Lyrics for the current track, an optional "now playing"
line in the bot's channel, and an avatar per bot. Controlled from the Music
Bots page or by text commands (below).

**Video streaming.** YouTube, Twitch, direct URLs and IPTV into a TeamSpeak
channel over WebRTC, through a Go sidecar (Pion) that drives FFmpeg, with
hardware encoding on VAAPI or NVENC.

**Accounts and security.** A setup wizard creates the first admin; there are
no default credentials. Sign-in is username and password, with a password
policy, a forced password change on next sign-in, and rate limits on the
login endpoints. Admins manage everything; viewers see only Music Request
History, for the servers an admin grants them under Settings → Users. The
number of trusted reverse proxy hops, which decides the client IP the rate
limits count, is also set under Settings → Users. Bot identities and the
Spotify client secret are stored AES-256-GCM encrypted; outbound requests are
SSRF-guarded; refresh tokens rotate with reuse detection.

## Quick start (Docker)

1. Clone the repository and create `.env` at its root:

   ```bash
   echo "JWT_SECRET=$(openssl rand -base64 32)" >> .env
   echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
   echo "SIDECAR_TOKEN=$(openssl rand -base64 32)" >> .env
   ```

   All three are required. `ENCRYPTION_KEY` encrypts stored credentials (bot
   identities, the Spotify client secret): back it up, and never regenerate it
   on an existing install, or every saved credential becomes unreadable.

2. Start the stack, either built from source or from CI's images:

   ```bash
   docker compose up -d --build                    # build on this host
   docker compose -f docker-compose.ghcr.yml up -d # pull prebuilt images
   ```

3. Open `http://localhost:3000/setup` and create the admin account. Add the
   TeamSpeak server under **Settings → Servers** (a name and the host the bots
   connect to), then create a bot on the **Music Bots** page, giving the
   server's voice port if it is not 9987.

**Hardware encoding** works on Intel and AMD GPUs through VAAPI. AMD
hardware has no VP9 encoder, so on AMD choose H.264; VP9 there falls back to
software. The GPU has to be passed through to the sidecar container, with its
unprivileged user in the group that owns the render node. Both are set up in
`docker-compose.yml`; `RENDER_GID` in `.env` overrides the group. Then turn it
on under Settings → Streaming.

**NVIDIA** GPUs encode H.264 through NVENC. The host needs the NVIDIA driver
and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html);
then add the override file, which passes the GPU through and sets
`SIDECAR_HW_BACKEND=nvenc`, and turn on hardware encoding with codec H.264:

```bash
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d
docker compose -f docker-compose.ghcr.yml -f docker-compose.nvidia.yml up -d   # prebuilt
```

## Upgrading to the bot-only version

An install from before the bot-only version still has the tables and columns
of the removed features. The container applies the schema on start with
`prisma db push`, which refuses a change that would drop data, so the first
start of the new image exits with Prisma's data-loss warning instead of
running against the old tables. Nothing is lost that way, but the backend
restart-loops until the schema is pushed by hand.

The procedure (back up the data directory, record row counts with
`prisma/table-counts.mjs`, run the one-off
`prisma db push --accept-data-loss`, compare the counts, start) is in
[Upgrading to the bot-only version](docs/deploying.md#upgrading-to-the-bot-only-version)
in `docs/deploying.md`. The backup is the only way back: an older image cannot
recreate the dropped columns on its own.

What users notice afterwards: no server-management pages; no Discord, flows,
journal or widgets; sign-in is password only (users who had MFA sign in with
their password, users created by SSO need an admin to set one); web bans are
gone; everything is in English, including a bot that was set to another
language; the music and admin command groups no longer restrict the bot's
commands; viewers see Music Request History only for the servers an admin
grants them under Settings → Users.

## Configuration

Most settings (encoder, GPU device, presets, IPTV, Spotify, YouTube cookies,
the now-playing notice, the password policy, proxy hops) are in the web UI.
The encoder and GPU device are not environment variables: the sidecar is
long-lived in Docker and its environment is fixed at container start, so they
travel with each stream instead.

**Backend**

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | — | **Required**, at least 32 characters. JWT signing secret. |
| `ENCRYPTION_KEY` | — | **Required**, at least 32 characters, must differ from `JWT_SECRET`. Encrypts stored credentials. |
| `SIDECAR_TOKEN` | — | Shared secret for the sidecar API. The sidecar refuses to start without it. |
| `SIDECAR_URL` | — | Sidecar address when it runs as its own container (e.g. `http://ts6-sidecar:9800`). |
| `BACKEND_INTERNAL_URL` | `http://backend:<PORT>` with `SIDECAR_URL`, else `http://127.0.0.1:<PORT>` | Where the sidecar reaches the backend to read YouTube video through yt-dlp. Set it only if the compose service is not named `backend`. |
| `FRONTEND_URL` | `http://localhost:5173` | Public origin the browser uses: the CORS allow-list. The compose files default it to `http://localhost:3000`. |
| `PORT` | `3001` | Backend port. |
| `DATABASE_URL` | `file:./data/ts6webui.db` | SQLite path. |
| `JWT_ACCESS_EXPIRY` / `JWT_REFRESH_EXPIRY` | `15m` / `7d` | Token lifetimes. |
| `MUSIC_DIR` | `/data/music` | Downloaded and uploaded music. |
| `YT_COOKIE_FILE` | — | Netscape cookies.txt for yt-dlp; also settable in Settings → YouTube. |

**Sidecar**

| Variable | Default | Description |
|---|---|---|
| `SIDECAR_LISTEN_ADDR` | `127.0.0.1` | API interface (`0.0.0.0` inside Docker, set by the image). Never publish port 9800. |
| `SIDECAR_H264_PROFILE` | `constrained_high` | H.264 profile. The others (`constrained_baseline`, `main`, `high`) do not play in the TeamSpeak client; they exist for testing. |
| `SIDECAR_HW_BACKEND` | `vaapi` | Which GPU hardware encoding uses: `vaapi` (Intel, AMD) or `nvenc` (NVIDIA, H.264 only). Set by `docker-compose.nvidia.yml`. |
| `SIDECAR_HW_DECODE` | on | With hardware encoding, also decode the source on the GPU. `0` decodes on the CPU. |
| `SIDECAR_GPU_FILTERS` | on | With VAAPI decoding, keep the frames on the GPU and scale them there (`scale_vaapi`) instead of copying them back to the CPU. `0` copies them back (for NVENC too). |
| `SIDECAR_GPU_FILTERS_NVENC` | off | `1` does the same for NVENC (`scale_cuda`). Uses far less CPU but is slower end to end; for a weak CPU with an NVIDIA card. |
| `SIDECAR_DEBUG_LOGS` | off | `1` logs per-packet detail and the full SDP offer and answer. Leave off: an SDP carries ICE credentials and host addresses. |
| `STUN_SERVERS` | — | Comma-separated STUN URLs. |
| `VIDEO_QUEUE_SIZE` / `AUDIO_QUEUE_SIZE` | `4096` / `2048` | RTP queue lengths, in packets. They hold what the A/V pacing is waiting to send. |
| `SYNC_PLAYOUT_BUFFER_MS` | `50` | Added to both tracks after they are lined up, to absorb the encoder's jitter. |
| `SYNC_MAX_DELAY_MS` | `1000` | The most one track is held back to meet the other, and the longest the first track waits for the other to start. |
| `SYNC_VIDEO_BIAS_MS` | `0` | Sends video this much later than audio, to correct lip sync by hand. |
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
| `!vol` / `!vol <0-100>` | Show / set volume (`!volume` works too) |
| `!np` / `!nowplaying`, `!info` | Current track, with progress |
| `!lyrics [search]` | Lyrics for the current track or a search |
| `!stream <url> [preset]` | Stream a video to the channel |
| `!tv` / `!tv <channel>` / `!tv reload` | List / start / refetch live TV channels |
| `!stopstream`, `!viewers` | Stop the stream / list its viewers |
| `!help` | List the commands |

Anyone who can message a bot can use every command. There is no server-group
restriction: reading the sender's groups needed the query interface, which the
bot does not use, so TeamSpeak's own channel permissions, which decide who
can reach the bot, decide who can command it. The now-playing notice is
turned on under **Settings → Music Bot**. `!tv` needs a playlist under
**Settings → Streaming**.

## Development

Requires Node.js 20+ and pnpm 9.

```bash
cp .env.example .env                  # then fill in the secrets
cp .env packages/backend/.env         # the Prisma CLI reads DATABASE_URL from here
pnpm install
pnpm --filter @ts6/common run build   # first: the other packages import it
pnpm db:generate                      # Prisma client
pnpm db:push                          # create or update the SQLite schema
pnpm dev                              # backend :3001, frontend :5173
```

The schema is applied with `prisma db push` (the Docker image does it on
start); this fork does not use migrations. `pnpm lint`, `pnpm typecheck` and
`pnpm test` are what CI runs, along with `go build ./...` and `go vet ./...`
in `packages/sidecar`. [`CLAUDE.md`](CLAUDE.md) lists the invariants that are
easy to break.

| Package | What |
|---|---|
| `packages/backend` | Express API, Prisma (SQLite), the voice bots (TeamSpeak client, audio, stream control) |
| `packages/frontend` | React, Vite, Tailwind, shadcn/ui, TanStack Query, i18next (English only) |
| `packages/common` | Types and constants shared by both |
| `packages/sidecar` | Go WebRTC media relay (Pion); drives FFmpeg |

## Requirements

- A TeamSpeak 6 server the bot can join as a client: its voice port (UDP,
  9987 by default, set per bot), and the server and channel passwords if it
  has them. No WebQuery, API key or SSH access is needed.
- For bot avatars, the server's file transfer port (TCP, 30033 by default),
  reachable from the backend under that same number, and a "max avatar file
  size" above 0 for the bot's server group.
- `ffmpeg` and `yt-dlp` on the backend (included in the Docker images).

## Troubleshooting

**The backend restarts in a loop after an upgrade, with "Use the
--accept-data-loss flag" in its log:** the database still has the tables of
the removed features. Follow
[Upgrading to the bot-only version](docs/deploying.md#upgrading-to-the-bot-only-version);
the data is untouched until you do.

**Hardware encoding stopped after an upgrade:** from a version that predates
the streaming settings, it is off until re-enabled in Settings → Streaming.
See [`docs/deploying.md`](docs/deploying.md).

**A bot's avatar is refused** (its settings say why; the bot stays connected
without one): the bot's server group needs a "max avatar file size" above 0
(stock 200 KB), and the backend must reach the server's file transfer port,
30033 by default, under that same number. See "Bot avatars" in
[`docs/fork-changes.md`](docs/fork-changes.md).

## License

MIT
