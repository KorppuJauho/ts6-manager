import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake ssh2 server: each SSH connection answers ServerQuery commands through
// `reply`, so tests can make one command flood or time out while the rest
// succeed. `refuse` makes the next connects fail the way an IP-level
// anti-flood drop does.
const harness = vi.hoisted(() => ({
  connections: [] as any[],
  written: [] as string[],
  writtenAt: [] as number[],
  reply: (_cmd: string): string | null => 'error id=0 msg=ok',
  refuse: null as null | 'drop' | 'auth' | 'hostkey',
}));

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('events');
  class FakeChannel extends EventEmitter {
    stderr = new EventEmitter();
    write(data: string) {
      const cmd = data.trim();
      harness.written.push(cmd);
      harness.writtenAt.push(Date.now());
      const answer = harness.reply(cmd);
      if (answer !== null) queueMicrotask(() => this.emit('data', Buffer.from(`${answer}\n`)));
    }
    close() { this.emit('close'); }
  }
  class Client extends EventEmitter {
    constructor() { super(); harness.connections.push(this); }
    connect(opts: any) {
      queueMicrotask(() => {
        if (harness.refuse === 'drop') { this.emit('error', new Error('Connection lost before handshake')); return; }
        if (harness.refuse === 'auth') { this.emit('error', new Error('All configured authentication methods failed')); return; }
        if (harness.refuse === 'hostkey') {
          if (!opts.hostVerifier(Buffer.from('a-different-key'))) {
            this.emit('error', new Error('Host denied (verification failed)'));
            return;
          }
        }
        this.emit('ready');
      });
    }
    shell(_pty: boolean, cb: (err: Error | null, ch: any) => void) {
      const ch = new FakeChannel();
      cb(null, ch);
      queueMicrotask(() => ch.emit('data', Buffer.from('TS3\nWelcome to the TeamSpeak ServerQuery interface.\n')));
    }
    // Asynchronous like ssh2's: the server's last replies arrive before the close.
    end() { queueMicrotask(() => this.emit('close')); }
  }
  return { Client };
});

const { SshQueryClient, FLOOD_RETRY_DELAYS_MS, sshHostKeyFingerprint } = await import('./ssh-query-client.js');
const { QueryPacer, SSH_COMMANDS_PER_WINDOW, FLOOD_WINDOW_MS } = await import('./query-pacer.js');

const OK = 'error id=0 msg=ok';
const FLOOD = 'error id=524 msg=client\\sis\\sflooding';

function makeClient(pinned: string | null = null, pacer?: InstanceType<typeof QueryPacer>) {
  const client = new SshQueryClient({ host: 'ts.test', port: 10022, username: 'serveradmin', password: 'pw', hostKeyFingerprint: pinned, pacer });
  client.on('error', () => { }); // EventBridge always listens; an unheard 'error' would throw
  return client;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => { });
  vi.spyOn(console, 'warn').mockImplementation(() => { });
  vi.spyOn(console, 'error').mockImplementation(() => { });
  harness.connections = [];
  harness.written = [];
  harness.writtenAt = [];
  harness.reply = () => OK;
  harness.refuse = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('keepalive', () => {
  it('treats a flood refusal as proof the session is alive', async () => {
    const client = makeClient();
    await client.connect();
    const closed = vi.fn();
    client.on('close', closed);
    harness.reply = (cmd) => (cmd === 'whoami' ? FLOOD : OK);

    await vi.advanceTimersByTimeAsync(30_000 * 5);

    expect(closed).not.toHaveBeenCalled();
    expect(client.isConnected).toBe(true);
    client.destroy();
  });

  it('disconnects and reconnects after three keepalives go unanswered', async () => {
    const client = makeClient();
    await client.connect();
    const closed = vi.fn();
    client.on('close', closed);
    harness.reply = (cmd) => (cmd === 'whoami' ? null : OK);

    await vi.advanceTimersByTimeAsync(30_000 * 3 + 5_000);
    expect(closed).toHaveBeenCalledTimes(1);

    harness.reply = () => OK;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.connections).toHaveLength(2);
    expect(client.isConnected).toBe(true);
    client.destroy();
  });
});

describe('registerEvents', () => {
  it('waits out a flood refusal and registers the event type anyway', async () => {
    const client = makeClient();
    await client.connect();
    let flooded = false;
    harness.reply = (cmd) => {
      if (cmd === 'servernotifyregister event=textserver' && !flooded) { flooded = true; return FLOOD; }
      return OK;
    };

    const result = client.registerEvents(1);
    await vi.advanceTimersByTimeAsync(FLOOD_RETRY_DELAYS_MS[0]);

    await expect(result).resolves.toEqual([]);
    expect(harness.written.filter((c) => c === 'servernotifyregister event=textserver')).toHaveLength(2);
    client.destroy();
  });

  it('waits out a flood refusal on "use sid", which everything after it needs', async () => {
    const client = makeClient();
    await client.connect();
    let flooded = false;
    harness.reply = (cmd) => {
      if (cmd === 'use sid=1' && !flooded) { flooded = true; return FLOOD; }
      return OK;
    };

    const result = client.registerEvents(1);
    await vi.advanceTimersByTimeAsync(FLOOD_RETRY_DELAYS_MS[0]);

    await expect(result).resolves.toEqual([]);
    client.destroy();
  });

  it('reports an event type that stays flooded after every retry', async () => {
    const client = makeClient();
    await client.connect();
    harness.reply = (cmd) => (cmd === 'servernotifyregister event=textprivate' ? FLOOD : OK);

    const result = client.registerEvents(1);
    await vi.advanceTimersByTimeAsync(FLOOD_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));

    await expect(result).resolves.toEqual(['textprivate']);
    expect(harness.written.filter((c) => c === 'servernotifyregister event=textprivate'))
      .toHaveLength(FLOOD_RETRY_DELAYS_MS.length + 1);
    client.destroy();
  });

  it('ignores "already registered" and reports other refusals without retrying', async () => {
    const client = makeClient();
    await client.connect();
    harness.reply = (cmd) => {
      if (cmd === 'servernotifyregister event=server') return 'error id=516 msg=already\\sregistered';
      if (cmd === 'servernotifyregister event=textchannel') return 'error id=2568 msg=insufficient\\sclient\\spermissions';
      return OK;
    };

    await expect(client.registerEvents(1)).resolves.toEqual(['textchannel']);
    expect(harness.written.filter((c) => c === 'servernotifyregister event=textchannel')).toHaveLength(1);
    client.destroy();
  });
});

describe('reconnecting', () => {
  it('keeps trying after a failed attempt instead of giving up', async () => {
    harness.refuse = 'drop';
    const client = makeClient();
    await expect(client.connect()).rejects.toThrow(/before handshake/);

    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect(harness.connections).toHaveLength(4);

    harness.refuse = null;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(client.isConnected).toBe(true);
    client.destroy();
  });

  it('backs off to at most 30 seconds between attempts', async () => {
    harness.refuse = 'drop';
    const client = makeClient();
    await client.connect().catch(() => { });
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 16_000);
    const before = harness.connections.length;

    await vi.advanceTimersByTimeAsync(29_999);
    expect(harness.connections).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.connections).toHaveLength(before + 1);
    client.destroy();
  });

  it('does not retry bad credentials', async () => {
    harness.refuse = 'auth';
    const client = makeClient();
    await expect(client.connect()).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.connections).toHaveLength(1);
    expect(client.hasFatalError).toBe(true);
  });

  it('does not retry a changed host key, and says so', async () => {
    harness.refuse = 'hostkey';
    const client = makeClient(sshHostKeyFingerprint(Buffer.from('the-pinned-key')));
    await expect(client.connect()).rejects.toThrow(/Host denied/);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.connections).toHaveLength(1);
    expect(client.hasFatalError).toBe(true);
    expect(client.hostKeyMismatch).toBe(true);
  });

  it('stops retrying once destroyed', async () => {
    harness.refuse = 'drop';
    const client = makeClient();
    await client.connect().catch(() => { });
    client.destroy();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.connections).toHaveLength(1);
  });
});

describe('destroy', () => {
  it('says quit so the server drops the query client', async () => {
    const client = makeClient();
    await client.connect();

    client.destroy();

    expect(harness.written.at(-1)).toBe('quit');
    expect(client.isConnected).toBe(false);
  });

  it('stays dead when the server answers the quit', async () => {
    const client = makeClient();
    await client.connect();
    const ready = vi.fn();
    client.on('ready', ready);

    client.destroy(); // the fake server answers "quit" with error id=0
    await vi.advanceTimersByTimeAsync(60_000);

    expect(ready).not.toHaveBeenCalled();
    expect(client.isConnected).toBe(false);
    expect(harness.written.filter((c) => c === 'whoami')).toHaveLength(0);
  });

  it('writes nothing to a session that never connected', async () => {
    harness.refuse = 'drop';
    const client = makeClient();
    await client.connect().catch(() => { });

    client.destroy();

    expect(harness.written).not.toContain('quit');
  });
});

describe('pacing', () => {
  it('keeps two sessions registering at once under the flood limit together', async () => {
    // What restarting a server's sessions does: the base session and a
    // command listener both register straight after connecting.
    const pacer = new QueryPacer();
    const base = makeClient(null, pacer);
    const listener = makeClient(null, pacer);
    await Promise.all([base.connect(), listener.connect()]);

    const done = Promise.all([base.registerEvents(1), listener.registerCommandListener(1, 5)]);
    await vi.advanceTimersByTimeAsync(20_000);
    await done;

    expect(harness.written.length).toBeGreaterThan(SSH_COMMANDS_PER_WINDOW * 2);
    for (const t of harness.writtenAt) {
      const inWindow = harness.writtenAt.filter((u) => u >= t && u < t + FLOOD_WINDOW_MS).length;
      expect(inWindow).toBeLessThanOrEqual(SSH_COMMANDS_PER_WINDOW);
    }
    base.destroy();
    listener.destroy();
  });

  it('does not time a command out while it waits for the pacer', async () => {
    const pacer = new QueryPacer(1, 8000);
    const client = makeClient(null, pacer);
    await client.connect();

    const first = client.executeCommand('whoami', 5000);
    const second = client.executeCommand('whoami', 5000); // waits ~8 s for a slot
    await vi.advanceTimersByTimeAsync(9000);

    await expect(first).resolves.toBe('');
    await expect(second).resolves.toBe('');
    client.destroy();
  });
});
