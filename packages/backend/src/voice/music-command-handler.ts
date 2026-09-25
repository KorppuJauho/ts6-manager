import type { PrismaClient } from '../../generated/prisma/index.js';
import { VoiceBotManager } from './voice-bot-manager.js';
import type { VoiceBot } from './voice-bot.js';
import type { QueueItem } from './playlist/queue.js';
import { downloadAndEnqueue, isSpotifyUrl, loadSpotifyConfig, enqueueSpotify, saveMusicRequest } from './music-ops.js';
import { isYouTubePlaylistUrl } from './playlist-import-plan.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import type { WebQueryClient } from '../ts-client/webquery-client.js';
import { requiredSgid, parseServerGroupIds, type MusicCommandAccessSettings } from './music-command-access.js';
import { fetchLyrics, chunkLyrics, lyricsInputFromTrack } from './lyrics.js';
import { loadTvChannels, matchChannel, sortChannelNames, type TvChannelMap, type TvSort } from './iptv.js';
import { getStreamSettings, parseChannelFilter } from '../utils/stream-settings.js';
import { messages, type BotMessages } from './bot-i18n/index.js';

const CMD_PREFIX = '!';

/**
 * Splits a command argument string into tokens, honouring single and double
 * quotes so channel/user names containing spaces can be passed as one token
 * (e.g. `!move "John Doe" "Salon de jeu"`). Unquoted runs split on whitespace.
 */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return tokens;
}

/** Formats a number of seconds as m:ss (or h:mm:ss past an hour). */
function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${sec}`;
  return `${m}:${sec}`;
}

/** Sends a reply back to wherever the command came from (private or channel). */
type ReplyFn = (msg: string) => void;

const MUSIC_COMMANDS = new Set([
  'radio', 'play', 'spotify', 'stop', 'pause', 'skip', 'next', 'prev',
  'vol', 'volume', 'np', 'nowplaying', 'queue', 'add',
  'stream', 'tv', 'stopstream', 'viewers',
  'lyrics',
  'move', 'moveall', 'channels', 'notif',
  'help', 'info',
]);

interface MusicCommandSettingsRow extends MusicCommandAccessSettings {
  notifyNowPlaying: boolean;
  /** Language the bot replies in; see voice/bot-i18n. */
  language: string;
}

/**
 * Handles text-based music commands (!radio, !play, !stop, etc.)
 * by listening directly on each VoiceBot's TS3 connection.
 *
 * The bot receives `notifytextmessage` in its own channel —
 * no SSH EventBridge needed.
 */
export class MusicCommandHandler {
  private registeredBots = new Set<number>();
  // Maps a music bot to the virtual server id (sid) of the TS server it sits
  // on, resolved once from its voice port via serveridgetbyport.
  private sidCache = new Map<number, number>();
  // Short-lived cache of the global MusicCommandSettings row. WebUI edits are
  // picked up within the TTL; !notif invalidates it immediately.
  private settingsCache: { at: number; value: MusicCommandSettingsRow } | null = null;
  private static readonly SETTINGS_TTL_MS = 5000;
  // nowPlaying listeners, kept so they can be detached in unregisterBot.
  private nowPlayingListeners = new Map<number, { bot: VoiceBot; listener: (item: QueueItem) => void }>();

  private playlistImporter: import('./playlist-import.js').PlaylistImporter | null = null;

  /** Parsed IPTV playlist, loaded on first !tv and kept until `!tv reload`. */
  private tvChannels: TvChannelMap | null = null;

  constructor(
    private prisma: PrismaClient,
    private voiceBotManager: VoiceBotManager,
    private connectionPool: ConnectionPool,
  ) {}

  setPlaylistImporter(importer: import('./playlist-import.js').PlaylistImporter): void {
    this.playlistImporter = importer;
  }

  /**
   * Register text message listener on a VoiceBot instance.
   * Called by VoiceBotManager whenever a bot is created/started.
   */
  registerBot(botId: number, bot: VoiceBot): void {
    if (this.registeredBots.has(botId)) return;
    this.registeredBots.add(botId);

    bot.on('textMessage', (data: Record<string, string>) => {
      this.onTextMessage(botId, bot, data).catch(err => {
        console.error(`[MusicCmd] Error processing text message on bot ${botId}: ${err.message}`);
      });
    });

    const npListener = (item: QueueItem) => {
      this.onNowPlaying(bot, item).catch((err) =>
        console.error(`[MusicCmd] now-playing notif failed on bot ${botId}: ${err.message}`));
    };
    bot.on('nowPlaying', npListener);
    this.nowPlayingListeners.set(botId, { bot, listener: npListener });

    console.log(`[MusicCmd] Registered text command listener on bot ${botId}`);
  }

  unregisterBot(botId: number): void {
    this.registeredBots.delete(botId);
    const entry = this.nowPlayingListeners.get(botId);
    if (entry) {
      entry.bot.off('nowPlaying', entry.listener);
      this.nowPlayingListeners.delete(botId);
    }
  }

  private async onTextMessage(botId: number, bot: VoiceBot, data: Record<string, string>): Promise<void> {
    const msg = (data.msg || '').trim();
    if (!msg.startsWith(CMD_PREFIX)) return;

    const parts = msg.substring(CMD_PREFIX.length).split(/\s+/);
    const command = parts[0].toLowerCase();
    if (!MUSIC_COMMANDS.has(command)) return;

    const args = parts.slice(1).join(' ').trim();
    const userClid = parseInt(data.invokerid || '0');
    if (!userClid) return;

    // Ignore messages from ourselves (the bot)
    if (userClid === bot.ts3ClientId) return;

    // Reply where we were asked: privately to a private message (targetmode 1),
    // in the channel to a channel message (targetmode 2).
    const inChannel = String(data.targetmode || '') === '2';
    const reply: ReplyFn = (m: string) => {
      try {
        if (inChannel) bot.sendChannelMessage(m);
        else bot.sendTextMessage(userClid, m);
      } catch (err: any) {
        console.error(`[MusicCmd] Failed to send reply: ${err.message}`);
      }
    };

    console.log(`[MusicCmd] Bot ${botId}: !${command} ${args} (from clid=${userClid}, ${inChannel ? 'channel' : 'private'})`);

    // Access control: music vs admin tier, gated by configured server groups.
    if (!(await this.checkAccess(botId, command, userClid, reply))) return;

    try {
      switch (command) {
        case 'radio':
          await this.handleRadio(botId, bot, reply, args);
          break;
        case 'play':
          await this.handlePlay(bot, reply, args);
          break;
        case 'spotify':
          await this.handleSpotify(bot, reply, args);
          break;
        case 'stop':
          this.handleStop(bot, reply);
          break;
        case 'pause':
          this.handlePause(bot, reply);
          break;
        case 'skip':
        case 'next':
          await this.handleSkip(bot, reply);
          break;
        case 'prev':
          await this.handlePrev(bot, reply);
          break;
        case 'vol':
        case 'volume':
          this.handleVolume(bot, reply, args);
          break;
        case 'np':
        case 'nowplaying':
          this.handleNowPlaying(bot, reply);
          break;
        case 'queue':
        case 'add':
          await this.handleQueue(bot, reply, args);
          break;
        case 'lyrics':
          await this.handleLyrics(bot, reply, args);
          break;
        case 'stream':
          await this.handleStream(bot, reply, args);
          break;
        case 'tv':
          await this.handleTv(bot, reply, args);
          break;
        case 'stopstream':
          await this.handleStopStream(bot, reply);
          break;
        case 'viewers':
          this.handleViewers(bot, reply);
          break;
        case 'channels':
          await this.handleChannels(botId, reply);
          break;
        case 'move':
          await this.handleMove(botId, reply, args);
          break;
        case 'moveall':
          await this.handleMoveAll(botId, bot, reply, args);
          break;
        case 'notif':
          await this.handleNotif(reply);
          break;
        case 'help':
          this.handleHelp(reply);
          break;
        case 'info':
          this.handleInfo(bot, reply);
          break;
      }
    } catch (err: any) {
      console.error(`[MusicCmd] Error handling !${command}: ${err.message}`);
      reply(this.m.genericError(err.message));
    }
  }

  // ─── Command Handlers ───────────────────────────────────────

  private async handleRadio(botId: number, bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    // Get serverConfigId for this bot from DB
    const dbBot = await this.prisma.musicBot.findUnique({ where: { id: botId }, select: { serverConfigId: true } });
    if (!dbBot) {
      reply(this.m.botConfigNotFound);
      return;
    }

    const stations = await this.prisma.radioStation.findMany({
      where: { serverConfigId: dbBot.serverConfigId },
      // Insertion order, not alphabetical: !radio prints the id beside each
      // station and users learn those numbers. Sorting by name reshuffles
      // every id as soon as a station is added.
      orderBy: { id: 'asc' },
    });

    if (stations.length === 0) {
      reply(this.m.radioNone);
      return;
    }

    // No argument — list stations
    if (!args) {
      const lines = stations.map((s: any) => `[${s.id}] ${s.name}${s.genre ? ` (${s.genre})` : ''}`);
      reply(this.m.radioHeader + '\n' + lines.join('\n'));
      return;
    }

    // Argument — play station by ID
    const stationId = parseInt(args);
    if (isNaN(stationId)) {
      reply(this.m.radioUsage);
      return;
    }

    const station = stations.find((s: any) => s.id === stationId);
    if (!station) {
      reply(this.m.radioNotFound(stationId));
      return;
    }

    const queueItem: QueueItem = {
      id: `radio_${station.id}`,
      title: station.name,
      artist: station.genre ?? 'Radio',
      filePath: '',
      source: 'radio',
      streamUrl: station.url,
    };

    await bot.playStream(queueItem);
    reply(this.m.radioNowPlaying(station.name));
  }

  private async handlePlay(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    if (!args) {
      if (bot.status === 'paused') {
        bot.resume();
        reply(this.m.resumed);
        return;
      }
      reply(this.m.usagePlay);
      return;
    }

    // Spotify links are metadata-only: delegate to the Spotify→YouTube path
    if (isSpotifyUrl(args)) {
      await this.handleSpotify(bot, reply, args);
      return;
    }

    if (!args.startsWith('http://') && !args.startsWith('https://')) {
      reply(this.m.usagePlayInvalidUrl);
      return;
    }

    // Cheap pre-check: only pay a metadata round trip for a URL that *is* a
    // playlist. Every other !play would otherwise get slower — and a video
    // opened from a playlist (which carries `&list=` too) would be swallowed
    // by a 50-track import instead of playing the linked track.
    if (isYouTubePlaylistUrl(args) && this.playlistImporter) {
      const handled = await this.playPlaylist(bot, reply, args);
      if (handled) return;
    }

    reply(this.m.loading);

    try {
      const { item, queued } = await downloadAndEnqueue(this.prisma, bot, args);
      if (queued) {
        reply(this.m.queued(item.artist, item.title, bot.queue.length));
      } else {
        reply(this.m.nowPlaying(item.artist, item.title));
      }
    } catch (err: any) {
      reply(this.m.failedToPlay(err.message));
    }
  }

  /**
   * Import a YouTube playlist, playing the first track as soon as it lands and
   * queueing the rest as they download. Returns false when the URL turns out
   * not to be a playlist — or when the import never got off the ground — so
   * the caller falls back to the single-track path.
   */
  private async playPlaylist(bot: VoiceBot, reply: ReplyFn, url: string): Promise<boolean> {
    const importer = this.playlistImporter!;
    // Read before start(): the importer replays already-present tracks as soon
    // as it can, so by the time we compose the reply the bot may already be
    // playing *because of this command*.
    const wasPlaying = bot.status === 'playing' || bot.status === 'paused';

    let result;
    try {
      result = await importer.start({
        url,
        serverConfigId: bot.currentConfig.serverConfigId,
        musicBotId: bot.currentConfig.id,
        onTrack: async (song) => {
          const item: QueueItem = {
            // Keyed on the video id like every other producer, so
            // PlayQueue.remove(id) and !queue remove behave the same here.
            id: `yt_${song.videoId}`,
            title: song.title,
            artist: song.artist ?? 'Unknown',
            duration: song.duration ?? 0,
            filePath: song.filePath,
            source: 'youtube' as const,
            sourceUrl: song.sourceUrl,
          };
          bot.queue.add(item);
          saveMusicRequest(this.prisma, bot, item);
          if (bot.status !== 'playing' && bot.status !== 'paused') {
            bot.queue.playAt(bot.queue.length - 1);
            await bot.play(item);
          }
        },
      });
    } catch (err: any) {
      // Nothing has confirmed this is a playlist yet — a metadata hiccup here
      // must not cost the user the single-video path that would have worked.
      console.warn(`[MusicCmd] playlist import could not start (${err.message}); falling back to single track`);
      return false;
    }

    if (result.kind === 'not-a-playlist') return false;
    if (result.kind === 'busy') {
      reply(this.m.importInProgress);
      return true;
    }

    const { job } = result;
    const parts = [this.m.importStarted(job.playlistName, job.total)];
    if (job.skipped) parts.push(this.m.importSkipped(job.skipped));
    if (job.truncated) parts.push(this.m.importTruncated(job.truncated));

    // Already-present tracks are enqueued too, so a pure re-import still
    // plays. Only promise playback when a track is actually on its way.
    const willEnqueue = job.total > 0 || job.skipped > 0;
    const tail = !willEnqueue
      ? this.m.importNothingToPlay
      : wasPlaying
        ? this.m.importQueuedBehind
        : this.m.importPlaybackStarts;
    reply(`${parts.join(', ')}.${tail}`);

    void this.reportWhenDone(job.jobId, reply);
    return true;
  }

  /** Poll the job and post a single summary when it finishes. */
  private async reportWhenDone(jobId: string, reply: ReplyFn): Promise<void> {
    const importer = this.playlistImporter!;
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const job = importer.get(jobId);
      if (!job) return;
      if (job.status === 'running') continue;

      if (job.status === 'error') {
        reply(this.m.importFailed(job.error ?? 'Unknown error'));
        return;
      }

      const lines = [`✅ Import finished: ${job.done} track(s) added.`];
      if (job.failures.length) {
        // Full detail belongs in the web UI; a TeamSpeak channel gets the first
        // few, or a long playlist turns into a wall of text.
        const shown = job.failures.slice(0, 5);
        lines.push(`⚠️ ${job.failures.length} failed:`);
        for (const f of shown) lines.push(`• ${f.title} — ${f.reason}`);
        if (job.failures.length > shown.length) {
          lines.push(`• and ${job.failures.length - shown.length} more (see the web UI)`);
        }
      }
      reply(lines.join('\n'));
      return;
    }
  }

  private async handleSpotify(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    if (!args) {
      reply(this.m.spotifyUsage);
      return;
    }

    const config = await loadSpotifyConfig(this.prisma);
    if (!config) {
      reply(this.m.spotifyNotConfigured);
      return;
    }

    reply(this.m.spotifyResolving);

    try {
      const result = await enqueueSpotify(this.prisma, bot, config, args);
      if (result.type === 'album') {
        reply(this.m.spotifyAlbum(result.name, result.added, result.total));
      } else if (result.added > 0) {
        reply(result.firstStarted ? this.m.spotifyNowPlaying(result.name) : this.m.spotifyQueued(result.name));
      } else {
        reply(this.m.spotifyFailed(result.failed[0] || 'no tracks added'));
      }
    } catch (err: any) {
      reply(this.m.spotifyFailed(err.message));
    }
  }

  private showQueue(bot: VoiceBot, reply: ReplyFn): void {
    const items = bot.queue.getAll();
    if (items.length === 0) {
      reply(this.m.queueEmpty);
      return;
    }

    const currentIdx = bot.queue.index;
    const lines = items.slice(0, 15).map((item, i) => {
      const marker = i === currentIdx ? '▶ ' : '  ';
      const artist = item.artist ? `${item.artist} - ` : '';
      const dur = item.duration ? ` [${Math.floor(item.duration / 60)}:${String(Math.floor(item.duration % 60)).padStart(2, '0')}]` : '';
      return `${marker}${i + 1}. ${artist}${item.title}${dur}`;
    });
    if (items.length > 15) lines.push(`  ... and ${items.length - 15} more`);
    reply(`${this.m.queueHeader(items.length)}\n${lines.join('\n')}`);
  }

  private async handleQueue(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    // No args or "show" — display current queue
    if (!args || args.toLowerCase() === 'show') {
      this.showQueue(bot, reply);
      return;
    }

    // !queue remove <index>
    if (args.toLowerCase().startsWith('remove ')) {
      const idx = parseInt(args.substring(7).trim()) - 1; // 1-based to 0-based
      const items = bot.queue.getAll();
      if (isNaN(idx) || idx < 0 || idx >= items.length) {
        reply(this.m.queueInvalidIndex(items.length));
        return;
      }
      const removed = items[idx];
      bot.queue.remove(removed.id);
      reply(this.m.queueRemoved(idx + 1, removed.title));
      return;
    }

    // !queue play <index>
    if (args.toLowerCase().startsWith('play ')) {
      const idx = parseInt(args.substring(5).trim()) - 1; // 1-based to 0-based
      const item = bot.queue.playAt(idx);
      if (!item) {
        reply(this.m.queueInvalidIndex(bot.queue.length));
        return;
      }
      if (item.streamUrl) {
        await bot.playStream(item);
      } else {
        await bot.play(item);
      }
      reply(this.m.queuePlaying(idx + 1, item.title));
      return;
    }

    // !queue clear
    if (args.toLowerCase() === 'clear') {
      bot.queue.clear();
      reply(this.m.queueCleared);
      return;
    }

    // URL provided — add to queue without interrupting
    if (!args.startsWith('http://') && !args.startsWith('https://')) {
      reply(this.m.queueUsage);
      return;
    }

    reply(this.m.loading);

    try {
      const { item, queued } = await downloadAndEnqueue(this.prisma, bot, args);
      if (queued) {
        reply(this.m.queued(item.artist, item.title, bot.queue.length));
      } else {
        reply(this.m.nowPlaying(item.artist, item.title));
      }
    } catch (err: any) {
      reply(this.m.failedToQueue(err.message));
    }
  }

  private handleStop(bot: VoiceBot, reply: ReplyFn): void {
    bot.stopAudio();
    reply(this.m.playbackStopped);
  }

  private handlePause(bot: VoiceBot, reply: ReplyFn): void {
    if (bot.status === 'paused') {
      bot.resume();
      reply(this.m.resumed);
    } else if (bot.status === 'playing') {
      bot.pause();
      reply(this.m.paused);
    } else {
      reply(this.m.nothingPlaying);
    }
  }

  private async handleSkip(bot: VoiceBot, reply: ReplyFn): Promise<void> {
    const next = bot.queue.next();
    if (next) {
      if (next.streamUrl) {
        await bot.playStream(next);
      } else {
        await bot.play(next);
      }
      reply(this.m.skippedTo(next.title));
    } else {
      bot.stopAudio();
      reply(this.m.queueEmptyStopped);
    }
  }

  private async handlePrev(bot: VoiceBot, reply: ReplyFn): Promise<void> {
    const prev = bot.queue.previous();
    if (prev) {
      if (prev.streamUrl) {
        await bot.playStream(prev);
      } else {
        await bot.play(prev);
      }
      reply(this.m.previousTrack(prev.title));
    } else {
      reply(this.m.noPreviousTrack);
    }
  }

  private handleVolume(bot: VoiceBot, reply: ReplyFn, args: string): void {
    if (!args) {
      const vol = bot.currentConfig.volume;
      reply(this.m.volumeIs(vol));
      return;
    }

    const vol = parseInt(args);
    if (isNaN(vol) || vol < 0 || vol > 100) {
      reply(this.m.volumeUsage);
      return;
    }

    bot.setVolume(vol);
    reply(this.m.volumeSet(vol));
  }

  private handleNowPlaying(bot: VoiceBot, reply: ReplyFn): void {
    const np = bot.nowPlaying;
    if (!np) {
      reply(this.m.nothingPlaying);
      return;
    }

    const artist = np.artist ? `${np.artist} - ` : '';
    const lines = [`Now playing: ${artist}${np.title}`];

    const progress = this.formatProgress(bot);
    if (progress) lines.push(progress);

    reply(lines.join('\n'));
  }

  /**
   * Builds a textual progress indicator for the current track, e.g.
   *   1:07 ▬▬▬▬▬▬●▬▬▬▬▬▬▬▬▬▬▬ 3:42
   * Returns null when there's nothing playing. For live streams (no known
   * duration) only the elapsed time is shown.
   */
  private formatProgress(bot: VoiceBot): string | null {
    const p = bot.playbackProgress;
    if (!p) return null;

    const pos = Math.max(0, Math.floor(p.position));

    // Live stream / unknown duration — just the elapsed time.
    if (!p.duration || p.duration <= 0) {
      return `⏱ ${formatTime(pos)} (en direct)`;
    }

    const dur = Math.floor(p.duration);
    const ratio = Math.min(1, pos / dur);
    const barLen = 18;
    const filled = Math.round(ratio * (barLen - 1));
    const bar = '▬'.repeat(filled) + '●' + '▬'.repeat(barLen - 1 - filled);
    return `${formatTime(pos)} ${bar} ${formatTime(dur)}`;
  }

  private handleInfo(bot: VoiceBot, reply: ReplyFn): void {
    const np = bot.nowPlaying;
    if (!np) {
      reply(this.m.nothingPlaying);
      return;
    }

    const lines: string[] = [this.m.infoHeader];
    lines.push(this.m.infoTitle(np.title));
    if (np.artist) lines.push(this.m.infoArtist(np.artist));

    if (np.duration) {
      const min = Math.floor(np.duration / 60);
      const sec = String(Math.floor(np.duration % 60)).padStart(2, '0');
      lines.push(this.m.infoDuration(`${min}:${sec}`));
    }

    const progress = this.formatProgress(bot);
    if (progress) lines.push(this.m.infoProgress(progress));

    // Direct link to the source (YouTube/Spotify via sourceUrl, radio via streamUrl)
    const link = np.sourceUrl || np.streamUrl;
    if (link) lines.push(this.m.infoLink(link));

    reply(lines.join('\n'));
  }

  private async handleLyrics(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    let input: { artist?: string; title?: string; query?: string };
    let label: string;

    if (args) {
      input = { query: args };
      label = args;
    } else {
      const np = bot.nowPlaying;
      if (!np) {
        reply(this.m.lyricsNoTrack);
        return;
      }
      ({ input, label } = lyricsInputFromTrack(np));
    }

    reply(this.m.lyricsSearching);
    const result = await fetchLyrics(input);
    if (!result) {
      reply(this.m.lyricsNotFound(label));
      return;
    }
    if (result.instrumental) {
      reply(this.m.lyricsInstrumental(result.artist ?? '', result.title));
      return;
    }

    const header = `🎤 ${result.artist ? `${result.artist} — ` : ''}${result.title}`;
    // Same per-message budget as !channels (~1KB TS limit).
    for (const chunk of chunkLyrics(header, result.lyrics, 900)) {
      reply(chunk);
    }
  }

  // ─── Channel / Client Management ──────────────────────────

  /**
   * Resolve the WebQuery client + virtual server id (sid) for a music bot.
   * The bot only knows its UDP voice port; serveridgetbyport maps that to the
   * sid. Result is cached per bot. Falls back to sid=1 if the lookup fails.
   */
  private async getServer(botId: number): Promise<{ client: WebQueryClient; sid: number }> {
    const dbBot = await this.prisma.musicBot.findUnique({
      where: { id: botId },
      select: { serverConfigId: true, voicePort: true },
    });
    if (!dbBot) throw new Error('Configuration du bot introuvable.');

    const client = await this.connectionPool.getOrLoad(dbBot.serverConfigId);

    let sid = this.sidCache.get(botId);
    if (!sid) {
      try {
        const res = await client.execute(0, 'serveridgetbyport', { virtualserver_port: dbBot.voicePort });
        const entry = Array.isArray(res) ? res[0] : res;
        sid = parseInt(entry?.server_id) || 1;
      } catch {
        sid = 1; // single-server fallback
      }
      this.sidCache.set(botId, sid);
    }

    return { client, sid };
  }

  /** Load the global command settings, cached for SETTINGS_TTL_MS. */
  private async getSettings(): Promise<MusicCommandSettingsRow> {
    if (this.settingsCache && Date.now() - this.settingsCache.at < MusicCommandHandler.SETTINGS_TTL_MS) {
      return this.settingsCache.value;
    }
    const row = await this.prisma.musicCommandSettings.findFirst();
    const value: MusicCommandSettingsRow = {
      musicCommandSgid: row?.musicCommandSgid ?? null,
      adminCommandSgid: row?.adminCommandSgid ?? null,
      notifyNowPlaying: row?.notifyNowPlaying ?? false,
      language: row?.language ?? 'en',
    };
    this.settingsCache = { at: Date.now(), value };
    return value;
  }

  private invalidateSettings(): void {
    this.settingsCache = null;
  }

  /**
   * The reply catalogue for the configured language.
   *
   * Read from the settings cache rather than threaded through every handler:
   * getSettings() runs in checkAccess before any command dispatches, so the
   * cache is populated and at most SETTINGS_TTL_MS stale by the time a reply
   * is built. Falls back to English when the cache is cold.
   */
  private get m(): BotMessages {
    return messages(this.settingsCache?.value.language);
  }

  /** Post a "now playing" line in the bot's current TS channel when enabled. */
  private async onNowPlaying(bot: VoiceBot, item: QueueItem): Promise<void> {
    const settings = await this.getSettings();
    if (!settings.notifyNowPlaying) return;
    const artist = item.artist ? `${item.artist} - ` : '';
    bot.sendChannelMessage(`♪ Now playing : ${artist}${item.title}`);
  }

  /** Resolve a server group's display name (best-effort, for messages). */
  private async groupName(client: WebQueryClient, sid: number, sgid: number): Promise<string> {
    try {
      const res = await client.execute(sid, 'servergrouplist');
      const arr = Array.isArray(res) ? res : res ? [res] : [];
      const g = arr.find((x: any) => Number(x.sgid) === sgid);
      return g?.name ? String(g.name) : `#${sgid}`;
    } catch {
      return `#${sgid}`;
    }
  }

  /**
   * Returns true if the invoker may run `command`. On denial it replies with a
   * message and returns false. Open/unconfigured tiers always pass.
   */
  private async checkAccess(botId: number, command: string, userClid: number, reply: ReplyFn): Promise<boolean> {
    const settings = await this.getSettings();
    const required = requiredSgid(command, settings);
    if (required == null) return true;

    const { client, sid } = await this.getServer(botId);

    let entry: any;
    try {
      const info = await client.execute(sid, 'clientinfo', { clid: String(userClid) });
      entry = Array.isArray(info) ? info[0] : info;
    } catch {
      // Could not resolve the invoker (e.g. just disconnected): fail closed.
      reply(this.m.permissionCheckFailed);
      return false;
    }

    const groups = parseServerGroupIds(entry?.client_servergroups);
    if (groups.includes(required)) return true;

    const name = await this.groupName(client, sid, required);
    reply(this.m.permissionDenied(name));
    return false;
  }

  /** Fetch the live channel list (array form) for a virtual server. */
  private async fetchChannels(client: WebQueryClient, sid: number): Promise<any[]> {
    const res = await client.execute(sid, 'channellist');
    return Array.isArray(res) ? res : res ? [res] : [];
  }

  /** Fetch the live client list (array form) for a virtual server. */
  private async fetchClients(client: WebQueryClient, sid: number): Promise<any[]> {
    const res = await client.execute(sid, 'clientlist');
    return Array.isArray(res) ? res : res ? [res] : [];
  }

  /** True for the spacer pseudo-channels used purely for visual separation. */
  private isSpacer(name: string): boolean {
    return name.startsWith('[spacer') || name.startsWith('[*spacer');
  }

  /**
   * Resolve a channel reference — either a numeric cid or a (possibly
   * space-containing) channel name — to a channel entry. Name matching is
   * case-insensitive: exact match first, then a unique substring match.
   * Throws a user-facing message on no/ambiguous match.
   */
  private resolveChannel(channels: any[], ref: string): any {
    const query = ref.trim();

    // Numeric → channel id
    if (/^\d+$/.test(query)) {
      const cid = Number(query);
      const byId = channels.find((c) => Number(c.cid) === cid);
      if (!byId) throw new Error(this.m.channelNotFoundById(cid));
      return byId;
    }

    const lower = query.toLowerCase();
    const named = channels.filter((c) => !this.isSpacer(String(c.channel_name)));

    const exact = named.filter((c) => String(c.channel_name).toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new Error(this.m.channelAmbiguous(query));
    }

    const partial = named.filter((c) => String(c.channel_name).toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      const ids = partial.slice(0, 6).map((c) => `[${c.cid}] ${c.channel_name}`).join(', ');
      throw new Error(this.m.channelAmbiguousList(query, ids));
    }

    throw new Error(this.m.channelNotFound(query));
  }

  private async handleChannels(botId: number, reply: ReplyFn): Promise<void> {
    const { client, sid } = await this.getServer(botId);
    const channels = await this.fetchChannels(client, sid);
    if (channels.length === 0) {
      reply(this.m.channelsNone);
      return;
    }

    // Build a tree (cid → children) so the list mirrors the channel hierarchy.
    const norm = channels.map((c) => ({
      cid: Number(c.cid),
      pid: Number(c.pid),
      order: Number(c.channel_order) || 0,
      name: String(c.channel_name),
    }));
    const childrenOf = new Map<number, typeof norm>();
    for (const c of norm) {
      if (!childrenOf.has(c.pid)) childrenOf.set(c.pid, []);
      childrenOf.get(c.pid)!.push(c);
    }
    for (const list of childrenOf.values()) list.sort((a, b) => a.order - b.order);

    const lines: string[] = [];
    const MAX = 60;
    const walk = (pid: number, depth: number): void => {
      for (const c of childrenOf.get(pid) ?? []) {
        if (lines.length < MAX && !this.isSpacer(c.name)) {
          lines.push(`${'  '.repeat(depth)}[${c.cid}] ${c.name}`);
        }
        walk(c.cid, depth + 1);
      }
    };
    walk(0, 0);

    if (norm.length > MAX) lines.push(this.m.channelsMore(norm.length - MAX));

    // Send in chunks to stay under the ~1KB per-message limit on long lists.
    const header = this.m.channelsHeader(norm.length);
    let buf = header;
    for (const line of lines) {
      if (buf.length + 1 + line.length > 900) {
        reply(buf);
        buf = line;
      } else {
        buf += '\n' + line;
      }
    }
    if (buf) reply(buf);
  }

  private async handleMove(botId: number, reply: ReplyFn, args: string): Promise<void> {
    const tokens = tokenizeArgs(args);
    if (tokens.length < 2) {
      reply(this.m.moveUsage);
      return;
    }

    const userQuery = tokens[0];
    const channelRef = tokens.slice(1).join(' ');

    const { client, sid } = await this.getServer(botId);
    const [channels, clients] = await Promise.all([
      this.fetchChannels(client, sid),
      this.fetchClients(client, sid),
    ]);

    const channel = this.resolveChannel(channels, channelRef);
    const target = this.resolveClient(clients, userQuery);

    await client.execute(sid, 'clientmove', { clid: target.clid, cid: channel.cid });
    reply(this.m.moved(String(target.client_nickname), String(channel.channel_name)));
  }

  private async handleMoveAll(botId: number, bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    const channelRef = tokenizeArgs(args).join(' ').trim();
    if (!channelRef) {
      reply(this.m.moveAllUsage);
      return;
    }

    const { client, sid } = await this.getServer(botId);
    const [channels, clients] = await Promise.all([
      this.fetchChannels(client, sid),
      this.fetchClients(client, sid),
    ]);

    const channel = this.resolveChannel(channels, channelRef);
    const cid = Number(channel.cid);

    // Real users only (client_type 0), excluding the bot itself and anyone
    // already in the destination channel.
    const toMove = clients.filter((c) =>
      String(c.client_type) === '0' &&
      Number(c.clid) !== bot.ts3ClientId &&
      Number(c.cid) !== cid,
    );

    if (toMove.length === 0) {
      reply(this.m.moveAllNobody(String(channel.channel_name)));
      return;
    }

    let moved = 0;
    const failed: string[] = [];
    // Sequential to stay friendly with the server's flood protection.
    for (const c of toMove) {
      try {
        await client.execute(sid, 'clientmove', { clid: c.clid, cid });
        moved++;
      } catch (err: any) {
        failed.push(String(c.client_nickname || c.clid));
      }
    }

    let msg = this.m.moveAllDone(moved, String(channel.channel_name));
    if (failed.length) msg += this.m.moveAllFailed(failed.join(', '));
    reply(msg);
  }

  private async handleNotif(reply: ReplyFn): Promise<void> {
    const row = await this.prisma.musicCommandSettings.findFirst();
    const next = !(row?.notifyNowPlaying ?? false);
    if (row) {
      await this.prisma.musicCommandSettings.update({ where: { id: row.id }, data: { notifyNowPlaying: next } });
    } else {
      await this.prisma.musicCommandSettings.create({ data: { notifyNowPlaying: next } });
    }
    this.invalidateSettings();
    reply(next
      ? this.m.notifEnabled
      : this.m.notifDisabled);
  }

  /**
   * Resolve a user reference (pseudo) to a connected client. Matches only real
   * clients (client_type 0), case-insensitively: exact first, then a unique
   * substring match. Throws a user-facing message on no/ambiguous match.
   */
  private resolveClient(clients: any[], ref: string): any {
    const lower = ref.trim().toLowerCase();
    const real = clients.filter((c) => String(c.client_type) === '0');

    const exact = real.filter((c) => String(c.client_nickname).toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new Error(this.m.userAmbiguous(ref));
    }

    const partial = real.filter((c) => String(c.client_nickname).toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      const names = partial.slice(0, 6).map((c) => c.client_nickname).join(', ');
      throw new Error(this.m.userAmbiguousList(ref, names));
    }

    throw new Error(this.m.userNotFound(ref));
  }

  private handleHelp(reply: ReplyFn): void {
    reply([this.m.helpHeader, ...this.m.helpLines].join('\n'));
  }

  // ─── Video Streaming Commands ─────────────────────────────

  private async handleStream(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    if (!args) {
      reply(this.m.streamUsage);
      return;
    }

    const parts = args.split(/\s+/);
    const url = parts[0];
    const preset = parts[1] || undefined;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      reply(this.m.streamInvalidUrl);
      return;
    }

    if (bot.videoStreaming) {
      // Change source if already streaming
      try {
        await bot.setVideoSource(url);
        reply(this.m.streamSourceChanged(url));
      } catch (err: any) {
        reply(this.m.genericError(err.message));
      }
      return;
    }

    reply(this.m.streamStarting);
    try {
      await bot.startVideoStream(url, preset);
      reply(this.m.streamStartedUrl(url));
    } catch (err: any) {
      reply(this.m.streamFailed(err.message));
    }
  }

  /**
   * !tv — start a live TV channel from the configured M3U playlist.
   *
   * The parsed list is cached for the process: playlists are large and change
   * rarely. `!tv reload` refetches it after the operator edits the playlist.
   */
  private async handleTv(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    const settings = await getStreamSettings(this.prisma);
    if (!settings.iptvEnabled || !settings.iptvPlaylistUrl) {
      reply(this.m.tvNotConfigured);
      return;
    }

    const query = args.trim().toLowerCase();
    if (query === 'reload') this.tvChannels = null;

    if (!this.tvChannels) {
      try {
        this.tvChannels = await loadTvChannels(
          settings.iptvPlaylistUrl,
          parseChannelFilter(settings.iptvChannelFilter),
        );
      } catch (err: any) {
        reply(this.m.tvLoadFailed(err.message));
        return;
      }
    }

    if (this.tvChannels.size === 0) {
      reply(this.m.tvNoChannels);
      return;
    }

    if (query === 'reload') {
      reply(this.m.tvReloaded(this.tvChannels.size));
      return;
    }

    if (!query) {
      const names = sortChannelNames(this.tvChannels, settings.iptvSort as TvSort);
      reply(this.m.tvAvailable(names.length, names.join(', ')));
      return;
    }

    const match = matchChannel(this.tvChannels, query);
    if (!match) {
      reply(this.m.tvNotFound(query));
      return;
    }

    reply(this.m.tvStarting(match));
    try {
      // The URL comes from the operator's own playlist, not from the user —
      // see resolveVideoUrl. The user supplied only the channel name.
      await bot.startVideoStream(this.tvChannels.get(match)!, undefined, undefined, undefined, {
        operatorConfigured: true,
        // The channel name the viewer asked for reads better in the bot's
        // nickname than the playlist URL behind it.
        title: match,
      });
    } catch (err: any) {
      reply(this.m.tvStartFailed(err.message));
    }
  }

  private async handleStopStream(bot: VoiceBot, reply: ReplyFn): Promise<void> {
    // A start still in progress counts: stopVideoStream() waits for it and
    // stops what it produces, where answering "none" let it run on.
    if (!bot.videoStreaming && !bot.videoStarting) {
      reply(this.m.streamNone);
      return;
    }
    await bot.stopVideoStream();
    reply(this.m.streamStopped);
  }

  private handleViewers(bot: VoiceBot, reply: ReplyFn): void {
    const status = bot.videoStreamStatus;
    if (!status.streaming) {
      reply(this.m.streamNone);
      return;
    }
    if (status.viewers.length === 0) {
      reply(this.m.viewersNone);
      return;
    }
    const lines = status.viewers.map((v) => {
      const duration = Math.floor((Date.now() - v.joinedAt) / 1000);
      return `  clid=${v.clid} (${duration}s)`;
    });
    reply(`${this.m.viewersHeader(status.viewerCount)}\n${lines.join('\n')}`);
  }

}
