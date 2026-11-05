# Chat commands

Send these to a bot in TeamSpeak, in its channel or as a private message.

| Command | Description |
|---|---|
| `!play <url>` / `!play` | Play a YouTube URL / resume |
| `!queue <url>` / `!add <url>` | Add to the queue |
| `!spotify <url>` | Play a Spotify track, album or playlist |
| `!radio` / `!radio <id>` | List radio stations / play one |
| `!pause`, `!stop`, `!skip` / `!next`, `!prev` | Playback control |
| `!vol` / `!vol <0-100>` | Show / set the volume |
| `!np`, `!info` | The current track |
| `!lyrics [search]` | Lyrics for the current track or a search |
| `!stream <url> [preset]` | Stream a video into the channel |
| `!tv` / `!tv <channel>` / `!tv reload` | List / start / refetch live TV channels |
| `!stopstream`, `!viewers` | Stop the stream / list its viewers |
| `!help` | List the commands |

Anyone who can message a bot can use its commands; TeamSpeak's channel
permissions decide who can reach it.

`!stream` takes YouTube, Twitch and direct video URLs. The optional preset
fixes the resolution; without one the stream follows the source, up to the
limit set in Settings → Streaming. `!tv` needs an IPTV playlist set there
first, and matches channel names loosely (`!tv mtv3` finds "MTV 3").
