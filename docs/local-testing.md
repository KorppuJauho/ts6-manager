# Local test environment (WSL2 on Windows 11)

A throwaway TeamSpeak server plus this manager, so changes can be tried
without touching a server other people are using.

## Read this first: what a local rig cannot tell you

**Hardware (VAAPI) encoding does not work under WSL2, and a failure there is
not a bug in this project.**

WSL2 exposes the GPU through `/dev/dxg` and Mesa's D3D12 driver. The
`/dev/dri/renderD128` visible inside WSL is a paravirtualised shim, not the
real `i915` device the Intel media driver needs. `ffmpeg -encoders` will
therefore not list `vp9_vaapi`, the encoder dropdown in Settings → Streaming
will show the VAAPI profiles as unavailable, and a stream started with one
selected falls back to the software encoder and logs why.

That fallback working *is* worth verifying — it is the path that protects a
misconfigured production host. But confirming that VAAPI itself encodes needs
real Linux on real hardware.

This is not an open question about the *hardware*: VP9 VAAPI encoding has run
in production on an Intel-based NAS since 2026-08 (see `docs/fork-changes.md`).
What a real-Linux run confirms is that the settings-driven encoder path still
reaches the GPU the way the earlier hardcoded version did.

Everything else this project does can be exercised locally: the settings UI
and its persistence, software VP8/VP9 streaming end to end, the DASH
video+audio resolution, presets, the idle auto-stop, the
bot's six reply languages, and `!tv` — which can point at a real IPTV proxy on
your LAN, since the backend does the fetching.

## Running alongside a production deployment

The test rig is built to coexist with a real deployment on the same host —
which is the point of running it on the server that has the GPU. Four things
keep them apart, and all four matter.

**Ports are shifted.** TeamSpeak +1, manager +10. Nothing in the test stack
binds a port production uses.

| | Production | Test |
|---|---|---|
| TeamSpeak voice (UDP) | 9987 | **9988** |
| TeamSpeak WebQuery | 10080 | **10081** |
| TeamSpeak ServerQuery (SSH) | 10022 | **10023** |
| TeamSpeak file transfer | 30033 | **30034** |
| Manager UI | 3000 | **3010** |
| Manager API | 3001 | **3011** |

Each is overridable in `.env` (`TEST_TS_VOICE_PORT`, `TEST_FRONTEND_PORT`, …)
if any of those are already taken.

**Container names are prefixed.** `docker-compose.yml` pins
`container_name: ts6-backend` / `ts6-sidecar` / `ts6-frontend`, and Docker
refuses duplicates — the test stack uses `ts6-test-*` so it does not collide
or, worse, get mistaken for the production container.

**Use a distinct project name.** Always pass `-p ts6-test`:

```bash
docker compose -p ts6-test -f docker-compose.test.yml up -d --build
docker compose -p ts6-test -f docker-compose.test.yml down -v
```

This is the one that protects your data. `down -v` deletes volumes *in the
current project* — run it without `-p` from the wrong directory and it can
take the production database with it. The project name scopes it.

**Volumes are separate.** `test-backend-data` and `test-music-data`, namespaced
again by the project name, so the test manager gets its own database and never
touches production's.

### The GPU is the one thing genuinely shared

To exercise VAAPI, add the override:

```bash
docker compose -p ts6-test \
  -f docker-compose.test.yml -f docker-compose.test.gpu.yml up -d --build
```

The render node supports multiple clients, so this does not break production.
But hardware *encode* is a limited fixed-function resource: two concurrent
streams contend, and on a modest iGPU that can show up as dropped frames on
both. Test while production is not streaming.

## One-time WSL setup

### Mirrored networking

Put this in `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Then from PowerShell: `wsl --shutdown`, and start WSL again.

This matters because the TeamSpeak voice port is **UDP**. Without mirrored
mode, WSL2 forwards TCP over `localhost` reasonably but UDP unreliably, so a
Windows TeamSpeak client connecting to a server inside WSL fails in ways that
look like a server problem. Mirrored mode makes `localhost` work in both
directions for both protocols.

### Docker

Either Docker Desktop with WSL2 integration enabled for your distro, or
`docker-ce` installed inside WSL. Docker Desktop is less setup on Windows 11.

### Repository

Clone **inside the WSL filesystem** (`~/ts6-manager`), not under `/mnt/c`.
Node and Docker builds on `/mnt/c` are slow enough to be painful, because
every file read crosses the Windows filesystem boundary.

## Choosing a TeamSpeak server image

This project talks to the server over the **WebQuery HTTP API** — the
ServerQuery replacement in modern TeamSpeak builds — not telnet ServerQuery.
A server build old enough to offer only telnet will not work with it.

The image is not pinned here because it depends on which build you have
access to. Check what your existing server runs (`docker ps` on the NAS, or
its container manager) and set it in `.env`:

```bash
TS_SERVER_IMAGE=<the image:tag your server uses>
```

Confirm two things against that image's own documentation, since they vary:
the licence-acceptance environment variable (the compose files use
`TS3SERVER_LICENSE=accept`, which the official images have used), and the data
directory if you want state to persist — the compose files deliberately keep
the server ephemeral so `docker compose down -v` gives a clean slate.

## Getting the WebQuery API key

The manager authenticates to the server with an API key sent as `x-api-key`,
not a username and password. A TeamSpeak server prints an initial admin key
**on first start**, so capture it:

```bash
docker compose -f docker-compose.tsserver.yml logs teamspeak | head -50
```

If you miss it, `docker compose down -v` and start again — the key is only
generated on a fresh instance.

## Day-to-day: server in Docker, manager native

Fast loop, hot reload, real stack traces.

```bash
docker compose -f docker-compose.tsserver.yml up -d

cp .env.example .env          # then fill in the secrets below
pnpm install
pnpm --filter @ts6/common run build    # required before anything typechecks
pnpm db:generate
pnpm dev
```

The UI is on http://localhost:5173 and the API on http://localhost:3001.

Generate the three secrets — they have no defaults, and the backend refuses to
start without them:

```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # ENCRYPTION_KEY  (must differ from JWT_SECRET)
openssl rand -hex 32   # SIDECAR_TOKEN
```

Then add the server in the UI under Settings → Connections:

| Field | Value |
|---|---|
| Host | `localhost` |
| WebQuery port | `10081` (the shifted test port) |
| API key | the admin key from the server's first-start log |
| Use HTTPS | off |

## Before deploying: the full stack

Mirrors production, and catches Dockerfile and compose problems the native
loop cannot see.

```bash
docker compose -p ts6-test -f docker-compose.test.yml up -d --build
# UI on http://localhost:3010
```

The `-p ts6-test` is not optional — see the isolation section above.

Both compose files publish the same host ports for TeamSpeak, so run one or
the other, not both.

## Verifying a video stream

1. Connect a TeamSpeak client (on Windows, to `localhost`) and join a channel.
2. Add a music bot in the UI and start it; it joins as a client.
3. `!stream <url>` in the channel, or `!tv <channel>` with a playlist
   configured under Settings → Streaming.
4. Watch the sidecar log for the encoder it resolved:

```bash
docker compose -p ts6-test -f docker-compose.test.yml logs -f sidecar
```

`[FFmpeg] Starting: … encoder=libvpx` is the expected result under WSL2. On a
real Linux host with the GPU override, expect `encoder=vp9_vaapi` — anything
else means the fallback fired, and the line above it says why. Anything
naming a `_vaapi` encoder means the probe found one, which would be a surprise
under WSL2 and worth investigating before trusting it.

## Troubleshooting

**The TeamSpeak client cannot connect, but the UI can.** The UI uses TCP
(WebQuery) and the client uses UDP. This is the mirrored-networking setting
above.

**Backend exits immediately on start.** It refuses to run without
`JWT_SECRET`, `ENCRYPTION_KEY` and — when `SIDECAR_URL` is set — `SIDECAR_TOKEN`.
The error names the missing one.

**`Cannot find module '@ts6/common'` everywhere.** The shared package has not
been built: `pnpm --filter @ts6/common run build`.

**The bot connects but no audio.** yt-dlp is installed into the backend image
at build time and updated at container start; running natively you need it on
your `PATH`, along with `ffmpeg`.

**Settings changes seem not to apply.** Stream settings are cached for five
seconds and the bot's command settings likewise. Wait, or restart the backend.
