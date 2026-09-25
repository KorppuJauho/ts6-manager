import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicCommandHandler } from './music-command-handler.js';
import { en } from './bot-i18n/en.js';
import type { VoiceBot } from './voice-bot.js';

const URL = 'https://video.test/a.mp4';
const COOLDOWN = 30_000;
const USER_CLID = 3;

/** The parts of a VoiceBot the commands here touch, with a flood clock on fake time. */
function fakeBot() {
  let floodedUntil = 0;
  const said: string[] = [];
  const bot = {
    ts3ClientId: 99,
    videoStreaming: false,
    videoStarting: false,
    get floodCooldownMs() { return Math.max(0, floodedUntil - Date.now()); },
    sendChannelMessage: vi.fn((m: string) => { said.push(m); }),
    sendTextMessage: vi.fn((_clid: number, m: string) => { said.push(m); }),
    startVideoStream: vi.fn(async () => { }),
    stopVideoStream: vi.fn(async () => { }),
    setVideoSource: vi.fn(async () => { }),
  };
  const floodFor = (ms: number) => { floodedUntil = Date.now() + ms; };
  return { bot, said, floodFor };
}

let handler: MusicCommandHandler;

/** A channel message to the bot, the way the TS client delivers it. */
function command(bot: unknown, text: string) {
  return (handler as any).onTextMessage(1, bot as VoiceBot, {
    msg: text, invokerid: String(USER_CLID), targetmode: '2',
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  handler = new MusicCommandHandler(null as any, null as any, null as any);
  // Access control reads server groups over WebQuery; not what is under test.
  vi.spyOn(handler as any, 'checkAccess').mockResolvedValue(true);
  vi.spyOn(handler as any, 'getSettings').mockResolvedValue({ notifyNowPlaying: true });
  vi.spyOn(console, 'log').mockImplementation(() => { });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('commands while the server’s flood protection blocks the bot', () => {
  it('sets every command aside, not only !stream, then says once that it has cleared', async () => {
    const { bot, said, floodFor } = fakeBot();
    floodFor(COOLDOWN);

    // The field report: !stream went unanswered while !stopstream was
    // answered — and every such answer was refused, prolonging the block.
    await command(bot, `!stream ${URL}`);
    await vi.advanceTimersByTimeAsync(4000);
    await command(bot, '!stopstream');
    await command(bot, '!help');
    await command(bot, `!stream ${URL}`);

    expect(said).toEqual([]);
    expect(bot.startVideoStream).not.toHaveBeenCalled();
    expect(bot.stopVideoStream).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(COOLDOWN);
    expect(said).toEqual([en.floodCleared]);
  });

  it('waits out a block that is extended while it waits', async () => {
    const { bot, said, floodFor } = fakeBot();
    floodFor(COOLDOWN);
    await command(bot, `!stream ${URL}`);

    await vi.advanceTimersByTimeAsync(COOLDOWN - 1000);
    floodFor(COOLDOWN); // something else the bot sent was refused meanwhile
    await vi.advanceTimersByTimeAsync(2000);
    expect(said).toEqual([]);

    await vi.advanceTimersByTimeAsync(COOLDOWN);
    expect(said).toEqual([en.floodCleared]);
  });

  it('drops what a command would say after tripping the block part-way', async () => {
    const { bot, said, floodFor } = fakeBot();
    bot.startVideoStream.mockImplementation(async () => {
      floodFor(COOLDOWN);
      throw new Error('setupstream refused by the server: client is flooding (error 524)');
    });

    await command(bot, `!stream ${URL}`);

    // "Starting…" went out before the block; the failure reply would not have.
    expect(said).toEqual([en.streamStarting]);
    await vi.advanceTimersByTimeAsync(COOLDOWN + 1000);
    expect(said).toEqual([en.streamStarting, en.floodCleared]);
  });

  it('stays out of the way when there is no block', async () => {
    const { bot, said } = fakeBot();
    bot.startVideoStream.mockRejectedValue(new Error('Video source blocked: private address'));

    await command(bot, `!stream ${URL}`);

    expect(said).toEqual([en.streamStarting, en.streamFailed('Video source blocked: private address')]);
  });

  it('skips the now-playing announcement during a block', async () => {
    const { bot, said, floodFor } = fakeBot();
    floodFor(COOLDOWN);

    await (handler as any).onNowPlaying(bot, { title: 'Song', artist: 'Artist' });
    expect(said).toEqual([]);

    await vi.advanceTimersByTimeAsync(COOLDOWN);
    await (handler as any).onNowPlaying(bot, { title: 'Song', artist: 'Artist' });
    expect(said).toHaveLength(1);
  });
});
