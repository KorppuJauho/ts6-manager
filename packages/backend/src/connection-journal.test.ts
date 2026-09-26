import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ clients: [] as any[] }));

vi.mock('./bot-engine/ssh-query-client.js', async () => {
  const { EventEmitter } = await import('events');
  class FakeSshQueryClient extends EventEmitter {
    isConnected = false;
    hasFatalError = false;
    destroyed = false;
    constructor() { super(); harness.clients.push(this); }
    async connect() { this.isConnected = true; this.emit('ready'); }
    async registerEvents() { return []; }
    async registerCommandListener() { }
    async executeCommand() { return ''; }
    destroy() { this.destroyed = true; this.isConnected = false; }
  }
  return { SshQueryClient: FakeSshQueryClient };
});
vi.mock('./utils/crypto.js', () => ({ decrypt: (s: string) => s }));

const { EventBridge } = await import('./bot-engine/event-bridge.js');
const { ConnectionJournal } = await import('./connection-journal.js');

const WITH_SSH = { id: 1, host: 'ts.test', sshPort: 10022, sshUsername: 'serveradmin', sshPassword: 'pw', sshHostKeyFp: null };
const WITHOUT_SSH = { id: 2, host: 'other.test', sshPort: 10022, sshUsername: null, sshPassword: null, sshHostKeyFp: null };
const ENTER = { client_type: '0', clid: '12', client_nickname: 'Alice' };

function setup() {
  const prisma = {
    appSetting: { findUnique: vi.fn(async () => null) },
    connectionLog: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({})),
    },
    tsServerConfig: {
      findMany: vi.fn(async () => [WITH_SSH, WITHOUT_SSH]),
      findUnique: vi.fn(async ({ where }: any) => [WITH_SSH, WITHOUT_SSH].find((s) => s.id === where.id) ?? null),
      update: vi.fn(async () => ({})),
    },
  } as any;
  const pool = { getOrLoad: vi.fn(async () => ({ execute: async () => [{ connection_client_ip: '' }] })) } as any;
  const voiceBots = { getAllBots: () => [] } as any;
  const bridge = new EventBridge(prisma);
  const journal = new ConnectionJournal(prisma, pool, voiceBots, bridge);
  return { prisma, bridge, journal };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { harness.clients = []; });

describe('ConnectionJournal on the engine\'s EventBridge', () => {
  it('joins the session the engine already holds instead of opening another', async () => {
    const { bridge, journal } = setup();
    await bridge.acquire(1, 1, 'engine');

    await journal.start();
    await settle();

    expect(harness.clients).toHaveLength(1);
    expect(bridge.getKeysHeldBy('journal')).toEqual(['1:1']);
    await journal.stop();
  });

  it('records a join on a watched server', async () => {
    const { prisma, bridge, journal } = setup();
    await journal.start();
    await settle();

    bridge.emit('tsEvent', 1, 1, 'notifycliententerview', ENTER);
    await settle();

    expect(prisma.connectionLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.connectionLog.create.mock.calls[0][0].data).toMatchObject({ source: 'teamspeak', login: 'Alice', serverConfigId: 1 });
    await journal.stop();
  });

  it('ignores events it did not subscribe for on the shared bridge', async () => {
    const { prisma, bridge, journal } = setup();
    await journal.start();
    await settle();

    bridge.emit('tsEvent', 1, 2, 'notifycliententerview', ENTER); // another virtual server
    bridge.emit('tsEvent', 2, 1, 'notifycliententerview', ENTER); // a server it does not watch
    bridge.emit('tsEvent', 1, 1, 'notifycliententerview', { ...ENTER, __cmd_listener_channel_id: '5' });
    bridge.emit('tsEvent', 1, 1, 'notifyclientleftview', ENTER);
    await settle();

    expect(prisma.connectionLog.create).not.toHaveBeenCalled();
    await journal.stop();
  });

  it('stop() closes the session when the engine does not hold it', async () => {
    const { bridge, journal } = setup();
    await journal.start();
    await settle();

    await journal.stop();

    expect(harness.clients[0].destroyed).toBe(true);
    expect(bridge.listenerCount('tsEvent')).toBe(0);
  });

  it('stop() leaves the engine\'s session and listener alone', async () => {
    const { bridge, journal } = setup();
    const engineListener = vi.fn();
    bridge.on('tsEvent', engineListener);
    await bridge.acquire(1, 1, 'engine');
    await journal.start();
    await settle();

    await journal.stop();

    expect(bridge.isConnected(1, 1)).toBe(true);
    expect(bridge.listenerCount('tsEvent')).toBe(1);
  });
});
