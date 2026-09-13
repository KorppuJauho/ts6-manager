import type { PrismaClient } from '../../generated/prisma/index.js';
import { VoiceBotManager } from './voice-bot-manager.js';
import type { VoiceBot } from './voice-bot.js';
import type { QueueItem } from './playlist/queue.js';
import { downloadAndEnqueue, isSpotifyUrl, loadSpotifyConfig, enqueueSpotify } from './music-ops.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import type { WebQueryClient } from '../ts-client/webquery-client.js';
import { requiredSgid, parseServerGroupIds, type MusicCommandAccessSettings } from './music-command-access.js';

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
  'move', 'moveall', 'channels', 'notif',
  'help', 'aide', 'info',
]);

interface MusicCommandSettingsRow extends MusicCommandAccessSettings {
  notifyNowPlaying: boolean;
}

// --- TV Channel Configuration & Loader ---
const tvChannels = new Map<string, string>();
const M3U_URL = "http://192.168.1.42:9191/output/m3u";

// Keywords that MUST be included in the channel name to be loaded
const ALLOWED_CHANNELS = [
  'yle tv1',
  'yle tv2',
  'mtv 3',
  'nelonen',
  'sub',
  'tv5',
  'jim',
  'v sport',
  'cmore',
  'mtv urheilu'
];

async function loadTvChannels(): Promise<void> {
  try {
    const res = await fetch(M3U_URL);
    const text = await res.text();
    const lines = text.split('\n');
    let currentName = '';

    tvChannels.clear();

    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        const parts = line.split(',');
        currentName = parts[parts.length - 1].trim().toLowerCase();
      } else if (line.startsWith('http') && currentName) {
        const isAllowed = ALLOWED_CHANNELS.some(allowedWord => currentName.includes(allowedWord));
        
        if (isAllowed) {
          tvChannels.set(currentName, line.trim());
        }
        currentName = '';
      }
    }
    console.log(`[TV] Loaded ${tvChannels.size} whitelisted channels from Dispatcharr.`);
  } catch (err) {
    console.error("[TV] Error loading channels:", err);
  }
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

  constructor(
    private prisma: PrismaClient,
    private voiceBotManager: VoiceBotManager,
    private connectionPool: ConnectionPool,
  ) {}

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
        case 'tv':
          await this.handleTv(bot, reply, args);
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
        case 'stream':
          await this.handleStream(bot, reply, args);
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
        case 'aide':
          this.handleHelp(reply);
          break;
        case 'info':
          this.handleInfo(bot, reply);
          break;
      }
    } catch (err: any) {
      console.error(`[MusicCmd] Error handling !${command}: ${err.message}`);
      reply(`Error: ${err.message}`);
    }
  }

  // ─── Command Handlers ───────────────────────────────────────

  private async handleRadio(botId: number, bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    // Get serverConfigId for this bot from DB
    const dbBot = await this.prisma.musicBot.findUnique({ where: { id: botId }, select: { serverConfigId: true } });
    if (!dbBot) {
      reply('Bot config not found.');
      return;
    }

    const stations = await this.prisma.radioStation.findMany({
      where: { serverConfigId: dbBot.serverConfigId },
      orderBy: { id: 'asc' },
    });

    if (stations.length === 0) {
      reply('No radio stations configured.');
      return;
    }

    // No argument — list stations
    if (!args) {
      const lines = stations.map((s: any) => `[${s.id}] ${s.name}${s.genre ? ` (${s.genre})` : ''}`);
      reply('Radio Stations:\n' + lines.join('\n'));
      return;
    }

    // Argument — play station by ID
    const stationId = parseInt(args);
    if (isNaN(stationId)) {
      reply('Usage: !radio <id> — Use !radio to list stations.');
      return;
    }

    const station = stations.find((s: any) => s.id === stationId);
    if (!station) {
      reply(`Station #${stationId} not found. Use !radio to list stations.`);
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
    reply(`Now playing: ${station.name}`);
  }

  private async handlePlay(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    if (!args) {
      if (bot.status === 'paused') {
        bot.resume();
        reply('Resumed.');
        return;
      }
      reply('Usage: !play <youtube-url | spotify link>');
      return;
    }

    // Spotify links are metadata-only: delegate to the Spotify→YouTube path
    if (isSpotifyUrl(args)) {
      await this.handleSpotify(bot, reply, args);
      return;
    }

    if (!args.startsWith('http://') && !args.startsWith('https://')) {
      reply('Please provide a valid URL. Usage: !play <youtube-url | lien Spotify>');
      return;
    }

    reply('Loading...');

    try {
      const { item, queued } = await downloadAndEnqueue(this.prisma, bot, args);
      if (queued) {
        reply(`Queued: ${item.artist} - ${item.title} (position #${bot.queue.length})`);
      } else {
        reply(`Now playing: ${item.artist} - ${item.title}`);
      }
    } catch (err: any) {
      reply(`Failed to play: ${err.message}`);
    }
  }

  private async handleSpotify(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    if (!args) {
      reply('Usage: !spotify <lien-track-ou-album-spotify>');
      return;
    }

    const config = await loadSpotifyConfig(this.prisma);
    if (!config) {
      reply('Spotify not configured (Settings → Spotify).');
      return;
    }

    reply('Resolving Spotify link...');

    try {
      const result = await enqueueSpotify(this.prisma, bot, config, args);
      if (result.type === 'album') {
        reply(`Album "${result.name}" : ${result.added}/${result.total} piste(s) ajoutée(s).`);
      } else if (result.added > 0) {
        reply(result.firstStarted ? `Now playing: ${result.name}` : `Queued: ${result.name}`);
      } else {
        reply(`Failed: ${result.failed[0] || 'no tracks added'}`);
      }
    } catch (err: any) {
      reply(`Spotify failed: ${err.message}`);
    }
  }

  private showQueue(bot: VoiceBot, reply: ReplyFn): void {
    const items = bot.queue.getAll();
    if (items.length === 0) {
      reply('Queue is empty.');
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
    reply(`Queue (${items.length} tracks):\n${lines.join('\n')}`);
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
        reply(`Invalid index. Queue has ${items.length} tracks.`);
        return;
      }
      const removed = items[idx];
      bot.queue.remove(removed.id);
      reply(`Removed #${idx + 1}: ${removed.title}`);
      return;
    }

    // !queue play <index>
    if (args.toLowerCase().startsWith('play ')) {
      const idx = parseInt(args.substring(5).trim()) - 1; // 1-based to 0-based
      const item = bot.queue.playAt(idx);
      if (!item) {
        reply(`Invalid index. Queue has ${bot.queue.length} tracks.`);
        return;
      }
      if (item.streamUrl) {
        await bot.playStream(item);
      } else {
        await bot.play(item);
      }
      reply(`Playing #${idx + 1}: ${item.title}`);
      return;
    }

    // !queue clear
    if (args.toLowerCase() === 'clear') {
      bot.queue.clear();
      reply('Queue cleared.');
      return;
    }

    // URL provided — add to queue without interrupting
    if (!args.startsWith('http://') && !args.startsWith('https://')) {
      reply('Usage: !queue [show|play <n>|remove <n>|clear|<url>]');
      return;
    }

    reply('Loading...');

    try {
      const { item, queued } = await downloadAndEnqueue(this.prisma, bot, args);
      if (queued) {
        reply(`Queued: ${item.artist} - ${item.title} (position #${bot.queue.length})`);
      } else {
        reply(`Now playing: ${item.artist} - ${item.title}`);
      }
    } catch (err: any) {
      reply(`Failed to queue: ${err.message}`);
    }
  }

  private handleStop(bot: VoiceBot, reply: ReplyFn): void {
    bot.stopAudio();
    reply('Playback stopped.');
  }

  private handlePause(bot: VoiceBot, reply: ReplyFn): void {
    if (bot.status === 'paused') {
      bot.resume();
      reply('Resumed.');
    } else if (bot.status === 'playing') {
      bot.pause();
      reply('Paused.');
    } else {
      reply('Nothing is playing.');
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
      reply(`Skipped to: ${next.title}`);
    } else {
      bot.stopAudio();
      reply('Queue empty — playback stopped.');
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
      reply(`Previous: ${prev.title}`);
    } else {
      reply('No previous track.');
    }
  }

  private handleVolume(bot: VoiceBot, reply: ReplyFn, args: string): void {
    if (!args) {
      const vol = bot.currentConfig.volume;
      reply(`Volume: ${vol}%`);
      return;
    }

    const vol = parseInt(args);
    if (isNaN(vol) || vol < 0 || vol > 100) {
      reply('Usage: !vol <0-100>');
      return;
    }

    bot.setVolume(vol);
    reply(`Volume set to ${vol}%.`);
  }

  private handleNowPlaying(bot: VoiceBot, reply: ReplyFn): void {
    const np = bot.nowPlaying;
    if (!np) {
      reply('Nothing is playing.');
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
      reply('No music is currently playing.');
      return;
    }

    const lines: string[] = ['♪ Now playing:'];
    lines.push(`  Title : ${np.title}`);
    if (np.artist) lines.push(`  Artist: ${np.artist}`);

    if (np.duration) {
      const min = Math.floor(np.duration / 60);
      const sec = String(Math.floor(np.duration % 60)).padStart(2, '0');
      lines.push(`  Duration: ${min}:${sec}`);
    }

    const progress = this.formatProgress(bot);
    if (progress) lines.push(`  Progress: ${progress}`);

    // Direct link to source (YouTube/Spotify via sourceUrl, radio via streamUrl)
    const link = np.sourceUrl || np.streamUrl;
    if (link) lines.push(`  Link   : [URL]${link}[/URL]`);

    reply(lines.join('\n'));
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
    };
    this.settingsCache = { at: Date.now(), value };
    return value;
  }

  private invalidateSettings(): void {
    this.settingsCache = null;
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
      reply('⛔ Unable to verify your permissions, command denied.');
      return false;
    }

    const groups = parseServerGroupIds(entry?.client_servergroups);
    if (groups.includes(required)) return true;

    const name = await this.groupName(client, sid, required);
    reply(`⛔ Command reserved for group « ${name} ».`);
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
      if (!byId) throw new Error(`No channel with ID ${cid}. Use !channels for the list.`);
      return byId;
    }

    const lower = query.toLowerCase();
    const named = channels.filter((c) => !this.isSpacer(String(c.channel_name)));

    const exact = named.filter((c) => String(c.channel_name).toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new Error(`Multiple channels named « ${query} ». Specify with the ID (see !channels).`);
    }

    const partial = named.filter((c) => String(c.channel_name).toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      const ids = partial.slice(0, 6).map((c) => `[${c.cid}] ${c.channel_name}`).join(', ');
      throw new Error(`Multiple channels match « ${query} » : ${ids}. Specify with the ID.`);
    }

    throw new Error(`Channel not found: « ${query} ». Use !channels for the list.`);
  }

  private async handleChannels(botId: number, reply: ReplyFn): Promise<void> {
    const { client, sid } = await this.getServer(botId);
    const channels = await this.fetchChannels(client, sid);
    if (channels.length === 0) {
      reply('No channels.');
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

    if (norm.length > MAX) lines.push(`  ... and ${norm.length - MAX} more`);

    // Send in chunks to stay under the ~1KB per-message limit on long lists.
    const header = `Channels (${norm.length}) :`;
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
      reply('Usage: !move <pseudo> <channel|id> — use quotes for names with spaces, e.g., !move "John Doe" "Channel 1"');
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
    reply(`Déplacé : ${target.client_nickname} → ${channel.channel_name}`);
  }

  private async handleMoveAll(botId: number, bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    const channelRef = tokenizeArgs(args).join(' ').trim();
    if (!channelRef) {
      reply('Usage: !moveall <channel|id> — move all users to this channel.');
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
      reply(`No one to move to ${channel.channel_name}.`);
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

    let msg = `${moved} user(s) moved to ${channel.channel_name}.`;
    if (failed.length) msg += ` Failed for: ${failed.join(', ')}.`;
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
      ? '🔔 Now playing notifications: enabled (all bots).'
      : '🔕 Now playing notifications: disabled.');
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
      throw new Error(`Multiple clients named "${ref}". Please be more specific.`);
    }

    const partial = real.filter((c) => String(c.client_nickname).toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      const names = partial.slice(0, 6).map((c) => c.client_nickname).join(', ');
      throw new Error(`Multiple clients match "${ref}": ${names}. Please be more specific.`);
    }

    throw new Error(`User not found: "${ref}".`);
  }

  private handleHelp(reply: ReplyFn): void {
    reply([
      'Available bot commands:',
      '  !play <url>            Play a YouTube video or Spotify link',
      '  !spotify <link>        Play a Spotify track/album',
      '  !radio [id]            List radio stations or start one',
      '  !queue [..]            View/manage the queue (show|play <n>|remove <n>|clear|<url>)',
      '  !add <url>             Add a track to the queue',
      '  !skip / !next          Skip to the next track',
      '  !prev                  Play the previous track',
      '  !pause                 Pause / Resume playback',
      '  !stop                  Stop playback',
      '  !vol <0-100>           Set or display the volume',
      '  !np / !nowplaying      Currently playing track',
      '  !info                  Details of the current track (artist, title, direct link)',
      '  !stream <url> [qual]   Stream a video (presets: 480p, 720p, 1080p)',
      '  !tv <channel>          Watch live TV (e.g. !tv mtv3)',
      '  !stopstream            Stop the video stream',
      '  !viewers               List viewers of the video stream',
      '  !channels              List channels and their IDs',
      '  !move <user> <chan>    Move a user (name or ID; use "quotes" for spaces)',
      '  !moveall <chan>        Move all users to a channel',
      '  !notif                 Enable/disable current track notification (TS channel)',
      '  !help                  Show this help menu',
    ].join('\n'));
  }

  // ─── Video Streaming Commands ─────────────────────────────

  private async handleStream(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    if (!args) {
      reply('Usage: !stream <url> [preset]  — Presets: 480p, 720p, 1080p');
      return;
    }

    const parts = args.split(/\s+/);
    const url = parts[0];
    const preset = parts[1] || undefined;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      reply('Please provide a valid URL.');
      return;
    }

    if (bot.videoStreaming) {
      // Change source if already streaming
      try {
        await bot.setVideoSource(url);
        reply(`Stream source changed to: ${url}`);
      } catch (err: any) {
        reply(`Error: ${err.message}`);
      }
      return;
    }

    reply('Starting video stream...');
    try {
      await bot.startVideoStream(url, preset);
      reply(`Video stream started: ${url}`);
    } catch (err: any) {
      reply(`Failed to start stream: ${err.message}`);
    }
  }

  private async handleTv(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    if (tvChannels.size === 0) {
      await loadTvChannels();
    }

    const query = args.trim().toLowerCase();

    if (!query) {
      const names = Array.from(tvChannels.keys());
      // KORJAUS 1: Tulostetaan oikeasti ne nimet, pilkulla erotettuna
      reply(`📺 Available channels (${names.length}):\n${names.join(', ')}\n\nUsage: !tv <channel> (e.g. !tv mtv3)`);
      return;
    }

    if (query === 'reload') {
      await loadTvChannels();
      reply(`📺 TV channels reloaded. Available channels: ${tvChannels.size}`);
      return;
    }

    // KORJAUS 2: "Fuzzy search", joka poistaa välilyönnit vertailun ajaksi
    const normalizedQuery = query.replace(/\s+/g, '');
    const match = Array.from(tvChannels.keys()).find(name => {
      const normalizedName = name.replace(/\s+/g, '');
      return normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName);
    });

    if (match) {
      const streamUrl = tvChannels.get(match);
      reply(`📺 Starting live TV: ${match.toUpperCase()}`);
      
      try {
        await bot.startVideoStream(streamUrl!, '720p'); 
      } catch (err) {
        reply(`Error starting TV stream: ${err}`);
      }
    } else {
      reply(`❌ TV channel not found for keyword: "${query}"`);
    }
  }

  private async handleStopStream(bot: VoiceBot, reply: ReplyFn): Promise<void> {
    if (!bot.videoStreaming) {
      reply('No active video stream.');
      return;
    }
    await bot.stopVideoStream();
    reply('Video stream stopped.');
  }

  private handleViewers(bot: VoiceBot, reply: ReplyFn): void {
    const status = bot.videoStreamStatus;
    if (!status.streaming) {
      reply('No active video stream.');
      return;
    }
    if (status.viewers.length === 0) {
      reply('No viewers connected.');
      return;
    }
    const lines = status.viewers.map((v) => {
      const duration = Math.floor((Date.now() - v.joinedAt) / 1000);
      return `  clid=${v.clid} (${duration}s)`;
    });
    reply(`Viewers (${status.viewerCount}):\n${lines.join('\n')}`);
  }

}
