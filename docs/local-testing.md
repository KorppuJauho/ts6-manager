# Local test environment (WSL2 on Windows 11)

A throwaway TeamSpeak server plus this manager, so changes can be tried
without touching a server other people are using.

## Read this first: what a local rig cannot tell you

**Hardware (VAAPI) encoding does not work under WSL2, and a failure there is
not a bug in this project.**

WSL2 exposes the GPU through `/dev/dxg` and Mesa's D3D12 driver. The
`/dev/dri/renderD128` visible inside WSL is a paravirtualised shim, not the
real `i915` device the Intel media driver needs. `ffmpeg -encoders` will
therefore not list `vp9_vaapi`, Settings → Streaming will mark every codec
"no GPU support", and a stream started with hardware encoding on falls back
to the software encoder and logs why.

That fallback working *is* worth verifying — it is the path that protects a
misconfigured production host. But confirming that VAAPI itself encodes needs
real Linux on real hardware.

This is not an open question about the *hardware*: VP9 VAAPI encoding has run
in production on an Intel-based NAS since 2026-08 (see `docs/fork-changes.md`).
What a real-Linux run confirms is that the settings-driven encoder path still
reaches the GPU the way the earlier hardcoded version did.

**NVIDIA (NVENC) is the exception: it does work under WSL2.** The Windows
NVIDIA driver is shared into WSL (`nvidia-smi` works there), and with the
NVIDIA Container Toolkit installed in WSL a container can encode with
`h264_nvenc` — verified on an RTX 5080. Layer the NVIDIA override on the test
stack:

```bash
docker compose -p ts6-test \
  -f docker-compose.test.yml -f docker-compose.nvidia.yml up -d --build
```

The sidecar log then starts with `[Startup] Hardware backend: nvenc`, and a
hardware H.264 stream logs `encoder=h264_nvenc`. Windows Task Manager's GPU
page shows the "Video Encode" and "Video Decode" engines working. If
`--gpus` fails with "no known GPU vendor found" from CDI, the toolkit is
missing or unconfigured in WSL (`nvidia-ctk runtime configure --runtime=docker`
and `nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`). Never install a
Linux NVIDIA driver inside WSL.

Everything else this project does can be exercised locally: the settings UI
and its persistence, software VP8/VP9 streaming end to end, the DASH
video+audio resolution, presets, the idle auto-stop, the bot's commands, and
`!tv` — which can point at a real IPTV proxy on your LAN, since the backend
does the fetching.

## Running alongside a production deployment

The test rig is built to coexist with a real deployment on the same host —
which is the point of running it on the server that has the GPU. Four things
keep them apart, and all four matter.

**Ports are shifted.** TeamSpeak +1, manager +10. Nothing in the test stack
binds a port production uses.

| | Production | Test |
|---|---|---|
| TeamSpeak voice (UDP) | 9987 | **9988** |
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

### Networking and idle shutdown

Put this in `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
vmIdleTimeout=-1

[general]
instanceIdleTimeout=-1

[experimental]
hostAddressLoopback=true
```

Then from PowerShell: `wsl --shutdown`, and start WSL again. Each line is
there for a failure it prevents:

- **`networkingMode=mirrored`** — the TeamSpeak voice port is **UDP**. Without
  mirrored mode, WSL2 forwards TCP from Windows reasonably but UDP unreliably,
  so a Windows TeamSpeak client connecting to a server inside WSL fails in
  ways that look like a server problem.
- **`hostAddressLoopback=true`** — without it the server connects but **video
  never does**: the stream stays at "connecting" and the sidecar logs
  `ICE: checking` and nothing after. Mirrored mode gives WSL the same LAN
  address as Windows, so the sidecar's WebRTC packets to the Windows client's
  candidate at that address are delivered inside WSL instead of to Windows.
  This setting passes them through.
- **The two idle timeouts** — WSL otherwise shuts the distro down seconds
  after the last terminal closes, and the test stack with it. With them off,
  WSL runs until `wsl --shutdown` or a reboot, and holds its memory until
  then; the containers restart on their own the next time WSL starts.

Mirrored mode does **not** mirror IPv6 loopback. From Windows, reach the rig
at **`127.0.0.1`**, not `localhost`: `localhost` tries `::1` first and times
out (browsers often fall back to IPv4; the TeamSpeak client and PowerShell
may not). Inside WSL, `localhost` is fine.

### Docker

Either Docker Desktop with WSL2 integration enabled for your distro, or
`docker-ce` installed inside WSL. Docker Desktop is less setup on Windows 11.

### Repository

Clone **inside the WSL filesystem** (`~/ts6-manager`), not under `/mnt/c`.
Node and Docker builds on `/mnt/c` are slow enough to be painful, because
every file read crosses the Windows filesystem boundary.

## Choosing a TeamSpeak server image

The manager does not use the server's query interfaces. The music bot joins
as an ordinary TeamSpeak client over the **voice port (UDP)**, so the server
only has to accept client connections there. WebQuery and SSH ServerQuery can
stay switched off, which is the TeamSpeak 6 default.

The image is not pinned here because it depends on which build you have
access to. Check what your existing server runs (`docker ps` on the NAS, or
its container manager) and set it in `.env`:

```bash
TS_SERVER_IMAGE=<the image:tag your server uses>
```

The compose files accept the licence under both naming schemes:
`TSSERVER_LICENSE_ACCEPTED` for TeamSpeak 6 and `TS3SERVER_LICENSE` for
TeamSpeak 3. A TeamSpeak 6 server without the acknowledgement exits at once
and restarts forever, so it is required, not optional. An image that uses
other names lists its own: `docker run --rm <image> tsserver --help`.

The compose files deliberately keep the server ephemeral, so
`docker compose down -v` gives a clean slate.

## Day-to-day: server in Docker, manager native

Fast loop, hot reload, real stack traces.

```bash
docker compose -f docker-compose.tsserver.yml up -d

cp .env.example .env          # then fill in the secrets below
cp .env packages/backend/.env # the Prisma CLI reads DATABASE_URL from here
pnpm install
pnpm --filter @ts6/common run build    # required before anything typechecks
pnpm db:generate
pnpm db:push                  # create the SQLite schema (only Docker does it on start)
pnpm dev
```

The UI is on http://127.0.0.1:5173 and the API on http://127.0.0.1:3001 (from
Windows; see the `127.0.0.1` note under networking).

Generate the three secrets — they have no defaults, and the backend refuses to
start without them:

```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # ENCRYPTION_KEY  (must differ from JWT_SECRET)
openssl rand -hex 32   # SIDECAR_TOKEN
```

Then add the server in the UI under Settings → Servers:

| Field | Value |
|---|---|
| Name | anything, e.g. `Local test` |
| Host | `localhost` |

The voice port is not part of the server record; each music bot has its own.
Here the manager runs directly in WSL, so the bot reaches the server through
the published port: give it voice port **`9988`**.

## Before deploying: the full stack

Mirrors production, and catches Dockerfile and compose problems the native
loop cannot see.

```bash
docker compose -p ts6-test -f docker-compose.test.yml up -d --build
# UI on http://127.0.0.1:3010
```

The `-p ts6-test` is not optional — see the isolation section above.

Here the manager runs in a container on the same Docker network as the
server, so it reaches it by service name on the **internal, unshifted** port
— not the one the table above lists for Windows. Under Settings → Servers:

| Field | Value |
|---|---|
| Name | anything, e.g. `Local test` |
| Host | `teamspeak` |

and on the music bot, voice port **`9987`**.

The shifted ports (9988, 30034, …) are only for things on the Windows side:
the TeamSpeak client, the browser. A bot given 9988 here sends its voice
packets to a port nothing listens on and fails with `Connection timeout`.

Both compose files publish the same host ports for TeamSpeak, so run one or
the other, not both.

## Verifying a video stream

1. Connect a TeamSpeak client (on Windows, to `127.0.0.1:9988`) and join a
   channel.
2. Add a music bot in the UI and start it; it joins as a client.
3. `!stream <url>` in the channel, or `!tv <channel>` with a playlist
   configured under Settings → Streaming.
4. Watch the sidecar log for the encoder it resolved:

```bash
docker compose -p ts6-test -f docker-compose.test.yml logs -f sidecar
```

`[FFmpeg] Starting: … encoder=libvpx` is the expected result under WSL2
without the NVIDIA override (`encoder=h264_nvenc` with it, for H.264). On a
real Linux host with the GPU override, expect `encoder=vp9_vaapi` — anything
else means the fallback fired, and the line above it says why. Anything
naming a `_vaapi` encoder means the probe found one, which would be a surprise
under WSL2 and worth investigating before trusting it.

## Troubleshooting

**The TeamSpeak client cannot connect, but the UI can.** The browser reaches
the manager over TCP, which WSL2 forwards well enough; the TeamSpeak client
uses UDP. This is the mirrored-networking setting above.

**The UI or the client times out on `localhost` from Windows.** IPv6 loopback
is not mirrored. Use `127.0.0.1`.

**The bot never connects: `Connection timeout`, over and over.** In the full
stack its voice port must be the internal `9987`, not `9988` — see the table
under "Before deploying".

**The stream starts but viewers stay at "connecting".** The sidecar log shows
`ICE: checking` and never `connected`. This is `hostAddressLoopback=true`
missing from `.wslconfig`.

**The stack is gone after closing the WSL terminal.** WSL shut the distro down
for being idle. See the idle timeouts under networking.

**Backend exits immediately on start.** It refuses to run without
`JWT_SECRET`, `ENCRYPTION_KEY` and — when `SIDECAR_URL` is set — `SIDECAR_TOKEN`.
The error names the missing one. In the container it also exits when the
schema push is refused ("Use the --accept-data-loss flag" in the log): the
volume holds a database from before the bot-only version. Follow
[the upgrade procedure](deploying.md#upgrading-to-the-bot-only-version), or for
a throwaway rig `down -v` and start fresh.

**`Cannot find module '@ts6/common'` everywhere.** The shared package has not
been built: `pnpm --filter @ts6/common run build`.

**The bot connects but no audio.** yt-dlp is installed into the backend image
at build time and updated at container start; running natively you need it on
your `PATH`, along with `ffmpeg`.

**Settings changes seem not to apply.** Stream settings are cached for five
seconds and the bot's command settings likewise. Wait, or restart the backend.
