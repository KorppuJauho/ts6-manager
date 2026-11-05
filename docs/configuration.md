# Configuration

Most settings are in the web UI: the encoder and GPU device, stream presets,
IPTV, Spotify, YouTube cookies, the now-playing notice, the password policy
and the reverse proxy hops. The encoder and GPU device are not environment
variables: the sidecar is long-lived in Docker and its environment is fixed at
container start, so they travel with each stream instead.

## Requirements

- A TeamSpeak 6 server the bot can join as a client: its voice port (UDP,
  9987 by default, set per bot), and the server and channel passwords if it
  has them. No WebQuery, API key or SSH access is needed.
- For bot avatars, the server's file transfer port (TCP, 30033 by default),
  reachable from the backend under that same number, and a "max avatar file
  size" above 0 for the bot's server group.
- `ffmpeg` and `yt-dlp` on the backend (included in the Docker images).

## Hardware encoding

**Intel and AMD** GPUs encode through VAAPI. AMD hardware has no VP9 encoder,
so on AMD choose H.264; VP9 there falls back to software. The GPU has to be
passed through to the sidecar container, with its unprivileged user in the
group that owns the render node. Both are set up in `docker-compose.yml`;
`RENDER_GID` in `.env` overrides the group. Then turn it on under
Settings → Streaming.

**NVIDIA** GPUs encode H.264 through NVENC. The host needs the NVIDIA driver
and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
Add the override file, which passes the GPU through and sets
`SIDECAR_HW_BACKEND=nvenc`, then turn on hardware encoding with codec H.264:

```bash
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d
docker compose -f docker-compose.ghcr.yml -f docker-compose.nvidia.yml up -d   # prebuilt
```

The UI probes the sidecar and greys out encoders the host cannot run. An
encoder that fails falls back to software instead of failing the stream.
H.264 is sent as Constrained High, the only H.264 profile the TeamSpeak client
decodes.

## Environment variables

### Backend

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | — | **Required**, at least 32 characters. JWT signing secret. |
| `ENCRYPTION_KEY` | — | **Required**, at least 32 characters, must differ from `JWT_SECRET`. Encrypts the bots' identities and the Spotify client secret. Back it up and never change it on an existing install. |
| `SIDECAR_TOKEN` | — | Shared secret for the sidecar API. The sidecar refuses to start without it. |
| `SIDECAR_URL` | — | Sidecar address when it runs as its own container (e.g. `http://ts6-sidecar:9800`). |
| `BACKEND_INTERNAL_URL` | `http://backend:<PORT>` with `SIDECAR_URL`, else `http://127.0.0.1:<PORT>` | Where the sidecar reaches the backend to read YouTube video through yt-dlp. Set it only if the compose service is not named `backend`. |
| `FRONTEND_URL` | `http://localhost:5173` | Public origin the browser uses: the CORS allow-list. The compose files default it to `http://localhost:3000`. |
| `PORT` | `3001` | Backend port. |
| `DATABASE_URL` | `file:./data/ts6webui.db` | SQLite path. |
| `JWT_ACCESS_EXPIRY` / `JWT_REFRESH_EXPIRY` | `15m` / `7d` | Token lifetimes. |
| `MUSIC_DIR` | `/data/music` | Downloaded and uploaded music. |
| `YT_COOKIE_FILE` | — | Netscape cookies.txt for yt-dlp; also settable in Settings → YouTube. |

### Sidecar

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

## Troubleshooting

**The backend restarts in a loop after an upgrade, with "Use the
--accept-data-loss flag" in its log:** the database still has the tables of
the removed features. Follow
[Upgrading to the bot-only version](deploying.md#upgrading-to-the-bot-only-version);
the data is untouched until you do.

**Hardware encoding stopped after an upgrade:** from a version that predates
the streaming settings, it is off until re-enabled in Settings → Streaming.
See [Deploying](deploying.md).

**A bot's avatar is refused** (its settings say why; the bot stays connected
without one): the bot's server group needs a "max avatar file size" above 0
(stock 200 KB), and the backend must reach the server's file transfer port,
30033 by default, under that same number. See "Bot avatars" in
[Fork changes](fork-changes.md).

**`!tv` says it has no channels:** set an IPTV playlist under
Settings → Streaming. If streams from an IPTV service fail to start, check the
service's connection limit; the stream's resolution probe opens a second
connection unless a fixed preset is chosen.
