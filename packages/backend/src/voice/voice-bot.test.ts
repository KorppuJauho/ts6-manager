import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Container mode, with a sidecar that is always healthy: these tests are
// about what happens between the bot and the TeamSpeak server. What the
// sidecar is asked to do is recorded, and URL validation — a DNS lookup — can
// be held open to widen the window a command arrives in.
const harness = vi.hoisted(() => ({
  sidecarCalls: [] as string[],
  holdValidation: null as Promise<void> | null,
}));

vi.mock('./streaming/sidecar-client.js', () => ({
  SidecarClient: class {
    async waitHealthy() { }
    async setSource() { harness.sidecarCalls.push('setSource'); }
    async stopSource() { harness.sidecarCalls.push('stopSource'); }
    async closePeer() { }
  },
}));
vi.mock('../utils/url-validator.js', () => ({
  validateUrl: async () => {
    if (harness.holdValidation) await harness.holdValidation;
    return { valid: true };
  },
}));
vi.mock('./streaming/probe.js', () => ({ probeVideoHeight: async () => 1080 }));

const { VoiceBot } = await import('./voice-bot.js');

const OWN_CLID = 7;
const SOURCE = 'https://video.test/a.mp4';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
}

function connectedBot() {
  const bot = new VoiceBot({
    id: 1, serverConfigId: 1, name: 'test', serverHost: 'ts.test', serverPort: 9987,
    nickname: 'MusicBot', volume: 50,
  });
  (bot as any)._status = 'connected';
  const client = (bot as any).client;
  const sent: string[] = [];
  vi.spyOn(client, 'sendCommand').mockImplementation((cmd: any) => { sent.push(cmd); });
  vi.spyOn(client, 'getClientId').mockReturnValue(OWN_CLID);

  const setupCommands = () => sent.filter((c) => c.startsWith('setupstream '));
  /** Answers the latest setupstream the way a server refusing it does. */
  const refuseLatest = () => {
    const code = /return_code=(\S+)/.exec(setupCommands().at(-1)!)![1];
    client.emit('ts3error', { id: '1538', msg: 'invalid parameter', return_code: code });
  };
  let streams = 0;
  /** Answers the latest setupstream the way a server accepting it does. */
  const acceptLatest = () => {
    const id = `stream-${++streams}`;
    client.emit('command', { name: 'notifystreamstarted', params: { id, clid: String(OWN_CLID) } });
    return id;
  };
  const stopCommands = () => sent.filter((c) => c.startsWith('stopstream '));
  /** Starts a stream and lets the server accept it. */
  const startStream = async () => {
    const before = setupCommands().length;
    const start = bot.startVideoStream(SOURCE);
    await vi.waitFor(() => expect(setupCommands()).toHaveLength(before + 1));
    const id = acceptLatest();
    await start;
    return id;
  };
  return { bot, client, sent, setupCommands, stopCommands, refuseLatest, acceptLatest, startStream };
}

beforeEach(() => {
  harness.sidecarCalls.length = 0;
  harness.holdValidation = null;
  process.env.SIDECAR_URL = 'http://sidecar.test:9800';
  process.env.SIDECAR_TOKEN = 'test-token';
  vi.spyOn(console, 'log').mockImplementation(() => { });
  vi.spyOn(console, 'warn').mockImplementation(() => { });
});

afterEach(() => {
  delete process.env.SIDECAR_URL;
  delete process.env.SIDECAR_TOKEN;
  vi.restoreAllMocks();
});

describe('VoiceBot.startVideoStream after a refused setupstream', () => {
  it('reports the server’s reason', async () => {
    const { bot, setupCommands, refuseLatest } = connectedBot();

    const start = bot.startVideoStream('https://video.test/a.mp4');
    await vi.waitFor(() => expect(setupCommands()).toHaveLength(1));
    refuseLatest();

    await expect(start).rejects.toThrow('refused by the server: invalid parameter');
    expect(bot.videoStreaming).toBe(false);
  });

  it('leaves no listener behind, however many times it fails', async () => {
    const { bot, client, setupCommands, refuseLatest } = connectedBot();
    const before = client.listenerCount('command');

    // The incident: three starts in a row that the server did not accept.
    // Each one used to leave its signaling attached, so the next working
    // stream answered every join request four times.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const start = bot.startVideoStream('https://video.test/a.mp4');
      await vi.waitFor(() => expect(setupCommands()).toHaveLength(attempt));
      refuseLatest();
      await expect(start).rejects.toThrow('refused');
    }

    expect(client.listenerCount('command')).toBe(before);
    expect(client.listenerCount('ts3error')).toBe(1); // the bot's own
  });

  it('turns away a second start while the first is still waiting', async () => {
    const { bot, setupCommands, refuseLatest } = connectedBot();

    const first = bot.startVideoStream('https://video.test/a.mp4');
    await vi.waitFor(() => expect(setupCommands()).toHaveLength(1));

    await expect(bot.startVideoStream('https://video.test/b.mp4'))
      .rejects.toThrow('Video stream is already starting');
    expect(setupCommands()).toHaveLength(1);

    refuseLatest();
    await expect(first).rejects.toThrow('refused');

    // Once the first has settled, a new start goes out again.
    const retry = bot.startVideoStream('https://video.test/a.mp4');
    await vi.waitFor(() => expect(setupCommands()).toHaveLength(2));
    refuseLatest();
    await expect(retry).rejects.toThrow('refused');
  });
});

// Each stop waits a second for its stopstream to be acknowledged, so these
// run in real time.
describe('VoiceBot stream commands that overlap', () => {
  it('a start given during a stop waits for it, then starts a fresh stream', async () => {
    const { bot, sent, setupCommands, stopCommands, startStream, acceptLatest } = connectedBot();
    await startStream();

    const stop = bot.stopVideoStream();
    // The case seen in the field: !stream a moment after !stopstream was
    // taken for a source change, on a stream the stop was about to end.
    expect(bot.videoStreaming).toBe(false);
    const restart = bot.startVideoStream(SOURCE);

    await stop;
    await vi.waitFor(() => expect(setupCommands()).toHaveLength(2));
    const setupAt = sent.lastIndexOf(setupCommands()[1]);
    expect(sent.indexOf(stopCommands()[0])).toBeLessThan(setupAt);

    acceptLatest();
    await restart;
    expect(bot.videoStreaming).toBe(true);
    expect(bot.videoStreamStatus.streamId).toBe('stream-2');
  });

  it('a stop given during a start stops the stream that start produces', async () => {
    const { bot, setupCommands, stopCommands, acceptLatest } = connectedBot();

    const start = bot.startVideoStream(SOURCE);
    await vi.waitFor(() => expect(setupCommands()).toHaveLength(1));
    expect(bot.videoStarting).toBe(true);

    const stop = bot.stopVideoStream();
    const id = acceptLatest();
    await start;
    await stop;

    expect(stopCommands()).toEqual([expect.stringContaining(`id=${id}`)]);
    expect(bot.videoStreaming).toBe(false);
  });

  it('a source change that finishes after a stop does not restart the encoder', async () => {
    const { bot, startStream } = connectedBot();
    await startStream();
    const setSourcesBefore = harness.sidecarCalls.filter((c) => c === 'setSource').length;

    const validation = deferred();
    harness.holdValidation = validation.promise;
    const change = bot.setVideoSource('https://video.test/b.mp4');
    const changeOutcome = expect(change).rejects.toThrow('The video stream was stopped');

    await bot.stopVideoStream();
    validation.release();

    await changeOutcome;
    expect(harness.sidecarCalls.filter((c) => c === 'setSource')).toHaveLength(setSourcesBefore);
    expect(bot.videoStreaming).toBe(false);
  });

  it('two stops at once end the stream once', async () => {
    const { bot, stopCommands, startStream } = connectedBot();
    await startStream();

    await Promise.all([bot.stopVideoStream(), bot.stopVideoStream()]);

    expect(stopCommands()).toHaveLength(1);
  });
});

describe('VoiceBot stream notification registration', () => {
  it('registers once per connection, not on every start', async () => {
    const { bot, client, sent, startStream } = connectedBot();
    const registrations = () => sent.filter((c) => c.startsWith('servernotifyregister ')).length;

    await startStream();
    await bot.stopVideoStream();
    await startStream();
    expect(registrations()).toBe(3); // channel, server, textchannel — once

    await bot.stopVideoStream();
    client.emit('disconnected');
    (bot as any)._status = 'connected';
    await startStream();
    expect(registrations()).toBe(6); // a new connection registers afresh
  });
});
