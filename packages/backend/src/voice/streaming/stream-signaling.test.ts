import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ts3Client } from '../tslib/client.js';
import { StreamSignaling } from './stream-signaling.js';

const OWN_CLID = 7;

/** The two things StreamSignaling uses a client for: events and sending. */
class FakeClient extends EventEmitter {
  sent: string[] = [];
  sendCommand(cmd: string): void {
    this.sent.push(cmd);
  }
  getClientId(): number {
    return OWN_CLID;
  }
  /** The return_code the last setupstream went out with. */
  lastReturnCode(): string {
    const match = /return_code=(\S+)/.exec(this.sent.at(-1) ?? '');
    if (!match) throw new Error('no return_code on the last command');
    return match[1];
  }
  announce(clid: number, id = 'stream-1'): void {
    this.emit('command', { name: 'notifystreamstarted', params: { id, clid: String(clid), name: 'Bot Stream' } });
  }
  reply(returnCode: string, id: string, msg: string): void {
    this.emit('ts3error', { id, msg, return_code: returnCode });
  }
}

function setup() {
  const client = new FakeClient();
  const signaling = new StreamSignaling(client as unknown as Ts3Client);
  return { client, signaling };
}

function listenersLeft(client: FakeClient, signaling: StreamSignaling) {
  return client.listenerCount('ts3error') + signaling.listenerCount('streamStarted');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('StreamSignaling.setupStream', () => {
  it('resolves with the stream the server starts for this client', async () => {
    const { client, signaling } = setup();
    const pending = signaling.setupStream({ name: 'Bot Stream' });

    // What the server sends, in the order it sends it: the notify, then "ok".
    const code = client.lastReturnCode();
    client.announce(OWN_CLID, 'abc');
    client.reply(code, '0', 'ok');

    await expect(pending).resolves.toMatchObject({ id: 'abc', clid: OWN_CLID });
    expect(listenersLeft(client, signaling)).toBe(0);
  });

  it('sends setupstream with a return_code that differs per call', () => {
    vi.useFakeTimers();
    const { client, signaling } = setup();
    void signaling.setupStream().catch(() => { });
    const first = client.lastReturnCode();
    void signaling.setupStream().catch(() => { });
    const second = client.lastReturnCode();

    expect(client.sent[0]).toMatch(/^setupstream /);
    expect(first).not.toBe(second);
  });

  it('rejects with the server’s reason when it refuses the stream', async () => {
    const { client, signaling } = setup();
    const pending = signaling.setupStream();

    client.reply(client.lastReturnCode(), '1538', 'invalid parameter');

    await expect(pending).rejects.toThrow(
      'setupstream refused by the server: invalid parameter (error 1538)',
    );
    expect(listenersLeft(client, signaling)).toBe(0);
  });

  it('keeps waiting through an "ok" reply that arrives before the stream', async () => {
    const { client, signaling } = setup();
    const pending = signaling.setupStream();

    const code = client.lastReturnCode();
    client.reply(code, '0', 'ok');
    client.announce(OWN_CLID);

    await expect(pending).resolves.toMatchObject({ clid: OWN_CLID });
  });

  it('ignores errors other commands draw while it waits', async () => {
    const { client, signaling } = setup();
    const pending = signaling.setupStream();

    client.reply('some-other-command', '1538', 'invalid parameter');
    client.emit('ts3error', { id: '768', msg: 'invalid channelID' }); // no return_code at all
    client.announce(OWN_CLID);

    await expect(pending).resolves.toMatchObject({ clid: OWN_CLID });
  });

  it('ignores a stream another client starts', async () => {
    vi.useFakeTimers();
    const { client, signaling } = setup();
    const pending = signaling.setupStream({}, 1000);
    const outcome = expect(pending).rejects.toThrow('setupstream timeout');

    client.announce(OWN_CLID + 1);
    await vi.advanceTimersByTimeAsync(1000);

    await outcome;
  });

  it('times out when the server never answers, and cleans up after itself', async () => {
    vi.useFakeTimers();
    const { client, signaling } = setup();
    const pending = signaling.setupStream({}, 10000);
    const outcome = expect(pending).rejects.toThrow('setupstream timeout: no answer from the server in 10s');

    await vi.advanceTimersByTimeAsync(10000);

    await outcome;
    expect(listenersLeft(client, signaling)).toBe(0);
  });

  it('is not settled twice by a stream that arrives after the timeout', async () => {
    vi.useFakeTimers();
    const { client, signaling } = setup();
    const pending = signaling.setupStream({}, 1000);
    const outcome = expect(pending).rejects.toThrow('setupstream timeout');
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;

    // A late notify still reaches the signaling's own bookkeeping, but no
    // longer the settled start.
    expect(() => client.announce(OWN_CLID, 'late')).not.toThrow();
    expect(signaling.getActiveStreams().has('late')).toBe(true);
  });
});

describe('StreamSignaling.dispose', () => {
  it('detaches from the client, so a discarded instance handles nothing more', () => {
    const { client, signaling } = setup();
    const seen = vi.fn();
    signaling.on('joinStreamRequest', seen);

    signaling.dispose();
    client.emit('command', { name: 'notifyjoinstreamrequest', params: { id: 's', clid: '3' } });

    expect(client.listenerCount('command')).toBe(0);
    expect(seen).not.toHaveBeenCalled();
  });
});
