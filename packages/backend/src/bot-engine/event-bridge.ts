import { EventEmitter } from 'events';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { SshQueryClient } from './ssh-query-client.js';
import { decrypt } from '../utils/crypto.js';
import { QueryPacer } from './query-pacer.js';

export declare interface EventBridge {
  on(event: 'tsEvent', listener: (configId: number, sid: number, eventName: string, data: Record<string, string>) => void): this;
  on(event: 'sshConnected', listener: (configId: number, sid: number) => void): this;
  on(event: 'sshDisconnected', listener: (configId: number, sid: number) => void): this;
  on(event: 'sshError', listener: (configId: number, sid: number, err: Error) => void): this;
  emit(event: 'tsEvent', configId: number, sid: number, eventName: string, data: Record<string, string>): boolean;
  emit(event: 'sshConnected', configId: number, sid: number): boolean;
  emit(event: 'sshDisconnected', configId: number, sid: number): boolean;
  emit(event: 'sshError', configId: number, sid: number, err: Error): boolean;
}

export class EventBridge extends EventEmitter {
  private connections: Map<string, SshQueryClient> = new Map();
  /** Connects still loading their server config, keyed like the maps they will land in. */
  private pending: Map<string, Promise<void>> = new Map();
  /**
   * Who needs each base session. The flow engine, the connection journal and
   * the Discord bridge share one session per server:sid, because TeamSpeak
   * counts every session from our IP against one flood allowance — a second
   * session with the same login is what broke event delivery. A session
   * closes only when its last holder lets go.
   */
  private holders: Map<string, Set<string>> = new Map();
  /** One per server: its flood limit counts every session from our IP together. */
  private pacers: Map<number, QueryPacer> = new Map();

  private pacerFor(configId: number): QueryPacer {
    let pacer = this.pacers.get(configId);
    if (!pacer) this.pacers.set(configId, pacer = new QueryPacer());
    return pacer;
  }

  constructor(private prisma: PrismaClient) {
    super();
  }

  private makeKey(configId: number, sid: number): string {
    return `${configId}:${sid}`;
  }

  async connectServer(configId: number, sid: number): Promise<void> {
    const key = this.makeKey(configId, sid);
    const existing = this.connections.get(key);
    if (existing && !existing.hasFatalError) return;
    // A session that failed fatally (bad credentials, changed host key) does
    // not retry by itself; a new connect replaces it once the cause is fixed.
    if (existing) {
      existing.destroy();
      this.connections.delete(key);
    }
    return this.dedupe(key, () => this.openServerConnection(configId, sid, key));
  }

  /**
   * Runs `open` once per key. A session is only claimed in its map after the
   * server config has loaded, so without this two callers arriving in that
   * window — the engine and a file-browser request, say — each open a session,
   * and TeamSpeak counts both against the same IP's flood allowance.
   */
  private dedupe(key: string, open: () => Promise<void>): Promise<void> {
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const attempt = open().finally(() => this.pending.delete(key));
    this.pending.set(key, attempt);
    return attempt;
  }

  private async openServerConnection(configId: number, sid: number, key: string): Promise<void> {
    const serverConfig = await this.prisma.tsServerConfig.findUnique({
      where: { id: configId },
    });

    if (!serverConfig) {
      console.warn(`[EventBridge] Server config ${configId} not found`);
      return;
    }

    if (!serverConfig.sshUsername || !serverConfig.sshPassword || !serverConfig.sshPort) {
      console.warn(`[EventBridge] Server config ${configId} has no SSH credentials, skipping SSH connection`);
      return;
    }

    const client = new SshQueryClient({
      host: serverConfig.host,
      port: serverConfig.sshPort,
      username: serverConfig.sshUsername,
      password: decrypt(serverConfig.sshPassword),
      hostKeyFingerprint: serverConfig.sshHostKeyFp,
      onHostKeyPinned: (fp) => this.persistHostKey(configId, fp),
      pacer: this.pacerFor(configId),
    });

    client.on('ready', async () => {
      console.log(`[EventBridge] SSH connected to ${serverConfig.host}:${serverConfig.sshPort} for sid=${sid}`);
      try {
        const failed = await client.registerEvents(sid);
        if (failed.length > 0) {
          console.error(`[EventBridge] ${key}: ${failed.length} event type(s) not registered (${failed.join(', ')}); flows triggered by them will not fire`);
        }
        this.emit('sshConnected', configId, sid);
      } catch (err: any) {
        console.error(`[EventBridge] Failed to register events for ${key}: ${err.message}`);
      }
    });

    client.on('event', (eventName: string, data: Record<string, string>) => {
      this.emit('tsEvent', configId, sid, eventName, data);
    });

    client.on('error', (err: Error) => {
      console.error(`[EventBridge] SSH error for ${key}: ${err.message}`);
      this.emit('sshError', configId, sid, err);
    });

    client.on('close', () => {
      console.log(`[EventBridge] SSH disconnected for ${key}`);
      this.emit('sshDisconnected', configId, sid);
    });

    this.connections.set(key, client);

    try {
      await client.connect();
    } catch (err: any) {
      console.error(`[EventBridge] Initial SSH connection failed for ${key}: ${err.message}`);
      // Auto-reconnect is handled internally by SshQueryClient (unless fatal)
      if (client.hasFatalError) {
        this.connections.delete(key);
      }
    }
  }

  /** Opens (or joins) the session for configId:sid and keeps it open for `holder`. */
  async acquire(configId: number, sid: number, holder: string): Promise<void> {
    const key = this.makeKey(configId, sid);
    let held = this.holders.get(key);
    if (!held) this.holders.set(key, held = new Set());
    held.add(holder);
    await this.connectServer(configId, sid);
  }

  /** Drops `holder`'s claim; the session closes once nobody holds it. */
  async release(configId: number, sid: number, holder: string): Promise<void> {
    const key = this.makeKey(configId, sid);
    const held = this.holders.get(key);
    held?.delete(holder);
    if (held && held.size > 0) return;
    this.holders.delete(key);
    await this.disconnectServer(configId, sid);
  }

  /** The configId:sid keys `holder` currently holds. */
  getKeysHeldBy(holder: string): string[] {
    return Array.from(this.holders.entries())
      .filter(([, held]) => held.has(holder))
      .map(([key]) => key);
  }

  async disconnectServer(configId: number, sid: number): Promise<void> {
    const key = this.makeKey(configId, sid);
    const client = this.connections.get(key);
    if (client) {
      client.destroy();
      this.connections.delete(key);
    }
  }

  isConnected(configId: number, sid: number): boolean {
    const key = this.makeKey(configId, sid);
    const client = this.connections.get(key);
    return client?.isConnected ?? false;
  }

  /**
   * Execute a raw ServerQuery command on an existing (or on-demand) SSH connection.
   * Reuses the same connection used for event listening — no extra server slots.
   */
  async executeCommand(configId: number, sid: number, command: string): Promise<string> {
    const key = this.makeKey(configId, sid);
    let client = this.connections.get(key);

    // Connect on demand if no connection exists yet
    if (!client || !client.isConnected) {
      await this.connectServer(configId, sid);
      client = this.connections.get(key);
      if (!client || !client.isConnected) {
        throw new Error('SSH not connected — check SSH credentials in server settings');
      }
    }

    return client.executeCommand(command);
  }

  /**
   * Closes every session to a server and reopens the ones still needed:
   * held base sessions and all command listeners. Called after its SSH
   * settings change or its pinned host key is forgotten, so the change takes
   * effect without restarting the backend. Sessions nobody holds (a file
   * browser's on-demand one) reopen on their next use.
   */
  async restartServer(configId: number): Promise<void> {
    const prefix = `${configId}:`;
    const baseSids = new Set<number>();
    for (const [key, client] of this.connections) {
      if (!key.startsWith(prefix)) continue;
      client.destroy();
      this.connections.delete(key);
    }
    for (const [key, held] of this.holders) {
      if (key.startsWith(prefix) && held.size > 0) baseSids.add(Number(key.split(':')[1]));
    }
    const listeners: Array<[number, number]> = [];
    for (const [key, client] of this.commandListeners) {
      if (!key.startsWith(prefix)) continue;
      client.destroy();
      this.commandListeners.delete(key);
      const [, sid, , channelId] = key.split(':');
      listeners.push([Number(sid), Number(channelId)]);
    }

    await Promise.all([
      ...Array.from(baseSids, (sid) => this.connectServer(configId, sid)),
      ...listeners.map(([sid, channelId]) => this.connectCommandListener(configId, sid, channelId)),
    ].map((p) => p.catch((err: any) => {
      console.error(`[EventBridge] Reconnect after settings change failed for server ${configId}: ${err.message}`);
    })));
  }

  getConnectedKeys(): string[] {
    return Array.from(this.connections.keys());
  }

  private commandListeners: Map<string, SshQueryClient> = new Map();

  /** Store a first-seen host key so a later change is detected, not trusted. */
  private persistHostKey(configId: number, fingerprint: string): void {
    this.prisma.tsServerConfig
      .update({ where: { id: configId }, data: { sshHostKeyFp: fingerprint } })
      .catch((err: any) => {
        console.error(`[EventBridge] Failed to persist SSH host key for config ${configId}: ${err.message}`);
      });
  }

  private makeCmdKey(configId: number, sid: number, channelId: number): string {
    return `${configId}:${sid}:cmd:${channelId}`;
  }

  async connectCommandListener(configId: number, sid: number, channelId: number): Promise<void> {
    const key = this.makeCmdKey(configId, sid, channelId);
    const existing = this.commandListeners.get(key);
    if (existing && !existing.hasFatalError) return;
    if (existing) {
      existing.destroy();
      this.commandListeners.delete(key);
    }
    return this.dedupe(key, () => this.openCommandListener(configId, sid, channelId, key));
  }

  private async openCommandListener(configId: number, sid: number, channelId: number, key: string): Promise<void> {
    const serverConfig = await this.prisma.tsServerConfig.findUnique({ where: { id: configId } });
    if (!serverConfig?.sshUsername || !serverConfig.sshPassword || !serverConfig.sshPort) return;

    const client = new SshQueryClient({
      host: serverConfig.host,
      port: serverConfig.sshPort,
      username: serverConfig.sshUsername,
      password: decrypt(serverConfig.sshPassword),
      hostKeyFingerprint: serverConfig.sshHostKeyFp,
      onHostKeyPinned: (fp) => this.persistHostKey(configId, fp),
      pacer: this.pacerFor(configId),
    });

    client.on('ready', async () => {
      console.log(`[EventBridge] CMD listener SSH connected for ${key}`);
      try {
        await client.registerCommandListener(sid, channelId);
      } catch (err: any) {
        console.error(`[EventBridge] CMD listener register failed for ${key}: ${err.message}`);
      }
    });

    client.on('event', (eventName: string, data: Record<string, string>) => {
      // Marker so engine can keep backward compatibility:
      // triggers WITHOUT channelId should only react to base connection events
      const enriched = { ...data, __cmd_listener_channel_id: String(channelId) };
      this.emit('tsEvent', configId, sid, eventName, enriched);
    });

    client.on('error', (err: Error) => console.error(`[EventBridge] CMD listener SSH error for ${key}: ${err.message}`));
    client.on('close', () => console.log(`[EventBridge] CMD listener SSH disconnected for ${key}`));

    this.commandListeners.set(key, client);
    try { await client.connect(); } catch (err: any) {
      console.error(`[EventBridge] CMD listener initial connect failed for ${key}: ${err.message}`);
      if (client.hasFatalError) this.commandListeners.delete(key);
    }
  }

  async disconnectCommandListener(configId: number, sid: number, channelId: number): Promise<void> {
    const key = this.makeCmdKey(configId, sid, channelId);
    const client = this.commandListeners.get(key);
    if (client) {
      client.destroy();
      this.commandListeners.delete(key);
    }
  }

  getCommandListenerChannelIds(configId: number, sid: number): number[] {
    const prefix = `${configId}:${sid}:cmd:`;
    return Array.from(this.commandListeners.keys())
      .filter(k => k.startsWith(prefix))
      .map(k => parseInt(k.split(':').pop() || '0', 10))
      .filter(n => Number.isFinite(n) && n > 0);
  }

  getCommandListenerKeys(): string[] {
    return Array.from(this.commandListeners.keys());
  }

  destroy(): void {
    for (const client of this.connections.values()) {
      client.destroy();
    }
    this.connections.clear();
    this.holders.clear();

    for (const client of this.commandListeners.values()) {
      client.destroy();
    }
    this.commandListeners.clear();

    this.removeAllListeners();
  }
}
