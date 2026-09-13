import type { PrismaClient } from '../generated/prisma/index.js';
import type { ConnectionPool } from './ts-client/connection-pool.js';
import type { VoiceBotManager } from './voice/voice-bot-manager.js';
import { EventBridge } from './bot-engine/event-bridge.js';
import { lookupCountry } from './utils/geo.js';

const RETENTION_KEY = 'journal.retentionDays';
const DEFAULT_RETENTION_DAYS = 90;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Records web and TeamSpeak connection events and purges old rows. */
export class ConnectionJournal {
  private eventBridge: EventBridge | null = null;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private prisma: PrismaClient,
    private pool: ConnectionPool,
    private voiceBotManager: VoiceBotManager,
  ) {}

  async start(): Promise<void> {
    await this.purgeOldEntries();
    this.purgeTimer = setInterval(() => {
      this.purgeOldEntries().catch((err) => console.error(`[Journal] Purge failed: ${err.message}`));
    }, PURGE_INTERVAL_MS);

    // Subscribe to TS connect events on every enabled server with SSH creds.
    const servers = await this.prisma.tsServerConfig.findMany({ where: { enabled: true } });
    const withSsh = servers.filter((s: any) => s.sshUsername && s.sshPassword);
    if (withSsh.length === 0) return;

    this.eventBridge = new EventBridge(this.prisma);
    this.eventBridge.on('tsEvent', (configId, sid, eventName, data) => {
      if (eventName !== 'notifycliententerview') return;
      this.onClientEnter(configId, sid, data).catch((err) => {
        console.error(`[Journal] enter-view handling failed: ${err.message}`);
      });
    });

    for (const server of withSsh) {
      // sid=1 is the default virtual server; the journal tracks the main one.
      this.eventBridge.connectServer(server.id, 1).catch((err) => {
        console.error(`[Journal] SSH connect failed for server ${server.id}: ${err.message}`);
      });
    }
    console.log(`[Journal] Watching ${withSsh.length} TS server(s) for connections`);
  }

  async stop(): Promise<void> {
    if (this.purgeTimer) { clearInterval(this.purgeTimer); this.purgeTimer = null; }
    if (this.eventBridge) {
      this.eventBridge.removeAllListeners();
      this.eventBridge = null;
    }
  }

  /** Record a web login attempt (fire-and-forget; never throws to the caller). */
  recordWebLogin(login: string, ip: string, success: boolean): void {
    const geo = lookupCountry(ip);
    this.prisma.connectionLog.create({
      data: { source: 'web', login, ip, country: geo.country, success, isBot: false },
    }).catch((err: any) => console.error(`[Journal] web log failed: ${err.message}`));
  }

  private async onClientEnter(configId: number, sid: number, data: Record<string, string>): Promise<void> {
    if (String(data.client_type) !== '0') return; // real clients only
    const clid = String(data.clid || '');
    const nickname = data.client_nickname || `Client #${clid}`;

    // Resolve the client IP (not present in the enter-view event)
    let ip = '';
    try {
      const client = await this.pool.getOrLoad(configId);
      const info = await client.execute(sid, 'clientinfo', { clid });
      const row = Array.isArray(info) ? info[0] : info;
      ip = row?.connection_client_ip || '';
    } catch {
      // permission or transient error — store without IP/geo
    }

    const geo = ip ? lookupCountry(ip) : { country: null, isPrivate: false };
    const isBot = this.isBotClid(configId, clid);

    await this.prisma.connectionLog.create({
      data: { source: 'teamspeak', login: nickname, ip, country: geo.country, success: true, isBot, serverConfigId: configId },
    });
  }

  /** True if the clid belongs to one of our connected music bots on this server. */
  private isBotClid(configId: number, clid: string): boolean {
    const n = parseInt(clid);
    if (!n) return false;
    return this.voiceBotManager.getAllBots().some(({ bot }) =>
      bot.currentConfig.serverConfigId === configId && bot.ts3ClientId === n,
    );
  }

  private async purgeOldEntries(): Promise<void> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: RETENTION_KEY } });
    const days = row ? parseInt(row.value) : DEFAULT_RETENTION_DAYS;
    if (!days || days <= 0) return; // 0 = keep everything
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.connectionLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    if (count > 0) console.log(`[Journal] Purged ${count} entries older than ${days} days`);
  }
}

export { RETENTION_KEY, DEFAULT_RETENTION_DAYS };
