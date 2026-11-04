![AI Assisted](https://img.shields.io/badge/AI%20Assisted-Project-00ADD8?style=for-the-badge&logo=dependabot&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

# TS6 Manager

**Music and video bots for TeamSpeak 6, run from a web UI. That is all it
does.** It does not manage TeamSpeak servers: no channels, clients,
permissions, bans or server settings. A bot joins your server as an ordinary
client, so no WebQuery, API key or SSH access is needed.

## What it does

- **Music bots**: queues, YouTube, Spotify links, internet radio, a music
  library with uploads and playlists, lyrics, a custom avatar per bot.
- **Video streams** into a channel: YouTube, Twitch, direct URLs and IPTV
  (`!tv`), with hardware encoding on Intel/AMD (VAAPI) or NVIDIA (NVENC).
- **[Chat commands](docs/chat-commands.md)** in TeamSpeak (`!play`,
  `!stream`, `!tv`, …) and control from the web UI.
- **Web accounts**: admins run the bots; viewers can see the music requests
  of the servers an admin grants them.

## Documentation

| | |
|---|---|
| [Quick start](docs/quick-start.md) | Running it with Docker |
| [Chat commands](docs/chat-commands.md) | Every command the bot takes |
| [Configuration](docs/configuration.md) | Environment variables, hardware encoding, requirements, troubleshooting |
| [Deploying](docs/deploying.md) | Prebuilt images, upgrading, rolling back, the bot-only upgrade |
| [Development](docs/development.md) | Running it from source, checks, code layout |
| [Local testing](docs/local-testing.md) | A local TeamSpeak server to test against |
| [Fork changes](docs/fork-changes.md) | What this fork changed and why |

## About this fork

A fork of [clusterzx/ts6-manager](https://github.com/clusterzx/ts6-manager),
by way of `coom/ts6-manager`. Those are full TeamSpeak management tools;
this fork kept only the music and video bot and removed the rest.

## License

MIT
