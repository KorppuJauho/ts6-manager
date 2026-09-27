import { beforeEach, describe, expect, it, vi } from 'vitest';

// TS presence events come over the flow engine's EventBridge. These tests
// cover only that wiring; nothing here talks to Discord.
const harness = vi.hoisted(() => ({ clients: [] as any[] }));

vi.mock('../bot-engine/ssh-query-client.js', async () => {
  const { EventEmitter } = await import('events');
  class FakeSshQueryClient extends EventEmitter {
    isConnected = false;
    hasFatalError = false;
    destroyed = false;
    constructor() { super(); harness.clients.push(this); }
    async connect() { this.isConnected = true; this.emit('ready'); }
    async registerEvents() { return []; }
    async registerCommandListener() { return []; }
    async executeCommand() { return ''; }
    destroy() { this.destroyed = true; this.isConnected = false; }
  }
  return { SshQueryClient: FakeSshQueryClient };
});
vi.mock('../utils/crypto.js', () => ({ decrypt: (s: string) => s, encrypt: (s: string) => s }));

const { EventBridge } = await import('../bot-engine/event-bridge.js');
const { DiscordBridge } = await import('./discord-bridge.js');

const SERVER = { id: 1, host: 'ts.test', sshPort: 10022, sshUsername: 'serveradmin', sshPassword: 'pw', sshHostKeyFp: null };
const SETTINGS = { serverConfigId: 1, virtualServerId: 1, notifyConnections: false, notificationsChannelId: null, notifyChannelId: null };

function setup() {
  const prisma = {
    tsServerConfig: {
      findUnique: vi.fn(async () => SERVER),
      update: vi.fn(async () => ({})),
    },
  } as any;
  const pool = { getOrLoad: vi.fn(async () => ({ execute: async () => [] })) } as any;
  const voiceBots = { onBotCreated: vi.fn(), getAllBots: () => [] } as any;
  const eventBridge = new EventBridge(prisma);
  const discord = new DiscordBridge(prisma, pool, voiceBots, eventBridge) as any;
  discord.settings = { ...SETTINGS };
  const onTsEvent = vi.spyOn(discord, 'onTsEvent').mockResolvedValue(undefined);
  vi.spyOn(discord, 'refreshMemberCountNickname').mockResolvedValue(undefined);
  return { eventBridge, discord, onTsEvent };
}

beforeEach(() => { harness.clients = []; });

describe('Discord presence on the engine\'s EventBridge', () => {
  it('joins the engine\'s session instead of opening another', async () => {
    const { eventBridge, discord } = setup();
    await eventBridge.acquire(1, 1, 'engine');

    await discord.startTsEventBridge();

    expect(harness.clients).toHaveLength(1);
    expect(eventBridge.getKeysHeldBy('discord')).toEqual(['1:1']);
  });

  it('handles only events from the server and virtual server it watches', async () => {
    const { eventBridge, discord, onTsEvent } = setup();
    await discord.startTsEventBridge();

    eventBridge.emit('tsEvent', 1, 1, 'notifycliententerview', { clid: '3' });
    eventBridge.emit('tsEvent', 1, 2, 'notifycliententerview', { clid: '4' });
    eventBridge.emit('tsEvent', 2, 1, 'notifycliententerview', { clid: '5' });
    eventBridge.emit('tsEvent', 1, 1, 'notifytextmessage', { msg: '!x', __cmd_listener_channel_id: '9' });

    expect(onTsEvent).toHaveBeenCalledTimes(1);
    expect(onTsEvent).toHaveBeenCalledWith('notifycliententerview', { clid: '3' });
  });

  it('stop() releases its hold and listener but leaves the engine\'s', async () => {
    const { eventBridge, discord } = setup();
    const engineListener = vi.fn();
    eventBridge.on('tsEvent', engineListener);
    await eventBridge.acquire(1, 1, 'engine');
    await discord.startTsEventBridge();

    await discord.stop();

    expect(eventBridge.getKeysHeldBy('discord')).toEqual([]);
    expect(eventBridge.isConnected(1, 1)).toBe(true);
    expect(eventBridge.listenerCount('tsEvent')).toBe(1);
  });

  it('stop() releases the session it acquired even if the settings changed since', async () => {
    const { eventBridge, discord } = setup();
    await discord.startTsEventBridge();
    discord.settings = { ...SETTINGS, serverConfigId: 2 };

    await discord.stop();

    expect(eventBridge.getConnectedKeys()).toEqual([]);
    expect(harness.clients[0].destroyed).toBe(true);
  });
});
