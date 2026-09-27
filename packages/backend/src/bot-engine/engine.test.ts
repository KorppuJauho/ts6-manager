import { beforeEach, describe, expect, it, vi } from 'vitest';

// A session that connects instantly; the engine's bookkeeping is what is
// under test, not SSH.
const harness = vi.hoisted(() => ({ clients: [] as any[] }));

vi.mock('./ssh-query-client.js', async () => {
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
vi.mock('../utils/crypto.js', () => ({ decrypt: (s: string) => s }));

const { BotEngine } = await import('./engine.js');

const SERVER = { id: 1, host: 'ts.test', sshPort: 10022, sshUsername: 'serveradmin', sshPassword: 'pw', sshHostKeyFp: null };
const CHANNEL_COMMAND_FLOW = {
  id: 8, name: 'channel-cmd', enabled: true, serverConfigId: 1, virtualServerId: 1,
  flowData: JSON.stringify({
    nodes: [{ id: 't', type: 'trigger_command', config: { command: '!hi', channelId: '5' } }],
    edges: [],
  }),
};
const EVENT_FLOW = {
  id: 7, name: 'greeter', enabled: true, serverConfigId: 1, virtualServerId: 1,
  flowData: JSON.stringify({
    nodes: [{ id: 't', type: 'trigger_event', config: { eventName: 'notifycliententerview' } }],
    edges: [],
  }),
};

function makeEngine(flows: any[] = []) {
  const prisma = {
    botFlow: {
      findMany: vi.fn(async () => flows.filter((f) => f.enabled)),
      findUnique: vi.fn(async ({ where }: any) => flows.find((f) => f.id === where.id) ?? null),
    },
    tsServerConfig: {
      findUnique: vi.fn(async () => SERVER),
      update: vi.fn(async () => ({})),
    },
  } as any;
  const wss = { clients: new Set() } as any;
  return new BotEngine(prisma, {} as any, wss, {} as any);
}

/** Lets fire-and-forget acquires settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { harness.clients = []; });

describe('BotEngine on a shared EventBridge', () => {
  it('stop() leaves other consumers\' event listeners in place', async () => {
    const engine = makeEngine();
    await engine.start();
    const bridge = engine.getEventBridge();
    const journalListener = vi.fn();
    bridge.on('tsEvent', journalListener);

    await engine.stop();

    expect(bridge.listenerCount('tsEvent')).toBe(1);
    bridge.emit('tsEvent', 1, 1, 'notifycliententerview', {});
    expect(journalListener).toHaveBeenCalledTimes(1);
  });

  it('disabling its last flow keeps a session another holder uses', async () => {
    const engine = makeEngine([EVENT_FLOW]);
    const bridge = engine.getEventBridge();
    await bridge.acquire(1, 1, 'journal');

    await engine.enableFlow(7);
    await settle();
    expect(harness.clients).toHaveLength(1);
    expect(bridge.getKeysHeldBy('engine')).toEqual(['1:1']);

    await engine.disableFlow(7);
    expect(bridge.isConnected(1, 1)).toBe(true);
    expect(harness.clients[0].destroyed).toBe(false);
  });

  it('disabling its last flow closes a session nobody else holds', async () => {
    const engine = makeEngine([EVENT_FLOW]);
    await engine.enableFlow(7);
    await settle();

    await engine.disableFlow(7);
    expect(engine.getEventBridge().getConnectedKeys()).toEqual([]);
    expect(harness.clients[0].destroyed).toBe(true);
  });
});

describe('BotEngine reloading a saved flow', () => {
  it('keeps the flow sessions open instead of reopening them', async () => {
    const engine = makeEngine([CHANNEL_COMMAND_FLOW]);
    await engine.enableFlow(8);
    await settle();
    const opened = harness.clients.length; // base session + channel listener
    expect(engine.getEventBridge().getCommandListenerChannelIds(1, 1)).toEqual([5]);

    await engine.reloadFlow(8);
    await settle();

    expect(harness.clients).toHaveLength(opened);
    expect(harness.clients.some((c) => c.destroyed)).toBe(false);
    expect(engine.getEventBridge().getCommandListenerChannelIds(1, 1)).toEqual([5]);
  });

  it('still closes a listener the saved flow no longer needs', async () => {
    const flows = [{ ...CHANNEL_COMMAND_FLOW }];
    const engine = makeEngine(flows);
    await engine.enableFlow(8);
    await settle();

    flows[0].flowData = EVENT_FLOW.flowData; // the command trigger was replaced
    await engine.reloadFlow(8);
    await settle();

    expect(engine.getEventBridge().getCommandListenerChannelIds(1, 1)).toEqual([]);
  });
});
