import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stands in for the SSH session: records every session opened, connects
// instantly unless a test holds it, and never touches the network.
const harness = vi.hoisted(() => ({
  clients: [] as any[],
  holdConnect: null as Promise<void> | null,
  failConnect: null as { fatal: boolean } | null,
}));

vi.mock('./ssh-query-client.js', async () => {
  const { EventEmitter } = await import('events');
  class FakeSshQueryClient extends EventEmitter {
    isConnected = false;
    hasFatalError = false;
    destroyed = false;
    commands: string[] = [];
    constructor(public options: any) {
      super();
      harness.clients.push(this);
    }
    async connect() {
      if (harness.holdConnect) await harness.holdConnect;
      if (harness.failConnect) {
        this.hasFatalError = harness.failConnect.fatal;
        throw new Error('connect failed');
      }
      this.isConnected = true;
      this.emit('ready');
    }
    async registerEvents() { return []; }
    async registerCommandListener() { }
    async executeCommand(cmd: string) { this.commands.push(cmd); return `ok ${cmd}`; }
    destroy() { this.destroyed = true; this.isConnected = false; }
  }
  return { SshQueryClient: FakeSshQueryClient };
});
vi.mock('../utils/crypto.js', () => ({ decrypt: (s: string) => s }));

const { EventBridge } = await import('./event-bridge.js');

const SERVER = { id: 1, host: 'ts.test', sshPort: 10022, sshUsername: 'serveradmin', sshPassword: 'pw', sshHostKeyFp: null };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
}

function stubPrisma(config: any = SERVER, hold?: Promise<void>) {
  return {
    tsServerConfig: {
      findUnique: vi.fn(async () => { if (hold) await hold; return config; }),
      update: vi.fn(async () => ({})),
    },
  } as any;
}

beforeEach(() => {
  harness.clients = [];
  harness.holdConnect = null;
  harness.failConnect = null;
});

describe('EventBridge connects', () => {
  it('opens one session when connects overlap while the config loads', async () => {
    const configLoad = deferred();
    const bridge = new EventBridge(stubPrisma(SERVER, configLoad.promise));

    const a = bridge.connectServer(1, 1);
    const b = bridge.connectServer(1, 1);
    configLoad.release();
    await Promise.all([a, b]);

    expect(harness.clients).toHaveLength(1);
    expect(bridge.isConnected(1, 1)).toBe(true);
  });

  it('opens one session when a command arrives while the connect is in flight', async () => {
    const hold = deferred();
    harness.holdConnect = hold.promise;
    const bridge = new EventBridge(stubPrisma());

    const connecting = bridge.connectServer(1, 1);
    const command = bridge.executeCommand(1, 1, 'ftgetfilelist cid=1');
    hold.release();
    await connecting;

    await expect(command).resolves.toBe('ok ftgetfilelist cid=1');
    expect(harness.clients).toHaveLength(1);
  });

  it('keeps sessions for different virtual servers apart', async () => {
    const bridge = new EventBridge(stubPrisma());
    await Promise.all([bridge.connectServer(1, 1), bridge.connectServer(1, 2)]);
    expect(harness.clients).toHaveLength(2);
  });

  it('opens one command listener when listener connects overlap', async () => {
    const configLoad = deferred();
    const bridge = new EventBridge(stubPrisma(SERVER, configLoad.promise));

    const a = bridge.connectCommandListener(1, 1, 5);
    const b = bridge.connectCommandListener(1, 1, 5);
    configLoad.release();
    await Promise.all([a, b]);

    expect(harness.clients).toHaveLength(1);
    expect(bridge.getCommandListenerChannelIds(1, 1)).toEqual([5]);
  });

  it('opens nothing for a server without SSH credentials', async () => {
    const bridge = new EventBridge(stubPrisma({ ...SERVER, sshUsername: null }));
    await bridge.connectServer(1, 1);
    expect(harness.clients).toHaveLength(0);
    await expect(bridge.executeCommand(1, 1, 'whoami')).rejects.toThrow(/SSH not connected/);
  });

  it('lets a later connect retry after a fatal failure', async () => {
    harness.failConnect = { fatal: true };
    const bridge = new EventBridge(stubPrisma());
    await bridge.connectServer(1, 1);
    expect(bridge.getConnectedKeys()).toEqual([]);

    harness.failConnect = null;
    await bridge.connectServer(1, 1);
    expect(harness.clients).toHaveLength(2);
    expect(bridge.isConnected(1, 1)).toBe(true);
  });
});
