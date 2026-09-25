import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Container mode, with a sidecar that is always healthy: these tests are
// about what happens between the bot and the TeamSpeak server.
vi.mock('./streaming/sidecar-client.js', () => ({
  SidecarClient: class {
    async waitHealthy() { }
    async setSource() { }
    async stopSource() { }
    async closePeer() { }
  },
}));

const { VoiceBot } = await import('./voice-bot.js');

const OWN_CLID = 7;

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
  return { bot, client, setupCommands, refuseLatest };
}

beforeEach(() => {
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
});
