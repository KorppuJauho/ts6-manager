import { describe, it, expect, vi } from 'vitest';

vi.mock('./audio/youtube.js', () => ({
  downloadYouTube: vi.fn(async (url: string) => ({
    filePath: '/music/abc123.opus',
    info: { id: 'abc123', title: 'Test Song', artist: 'Test Artist', duration: 180, thumbnail: '', url },
  })),
  searchYouTube: vi.fn(async () => [
    { id: 'vid456', title: 'Found Song', artist: 'Someone', duration: 120, thumbnail: '' },
  ]),
}));

import { resolvePlayQuery, downloadAndEnqueue } from './music-ops.js';
import { PlayQueue } from './playlist/queue.js';

function fakeBot(status: string = 'connected') {
  return {
    queue: new PlayQueue(),
    status,
    play: vi.fn(async () => { }),
    currentConfig: { serverConfigId: null },
  } as any;
}

const prisma = {} as any; // history save is skipped without a serverConfigId

describe('resolvePlayQuery', () => {
  it('passes URLs through untouched', async () => {
    expect(await resolvePlayQuery('https://youtu.be/xyz')).toBe('https://youtu.be/xyz');
  });

  it('turns search terms into the first YouTube result URL', async () => {
    expect(await resolvePlayQuery('some song')).toBe('https://www.youtube.com/watch?v=vid456');
  });
});

describe('downloadAndEnqueue', () => {
  it('starts playing immediately when the bot is idle', async () => {
    const bot = fakeBot('connected');
    const { item, queued } = await downloadAndEnqueue(prisma, bot, 'https://youtu.be/abc123');
    expect(queued).toBe(false);
    expect(bot.play).toHaveBeenCalledWith(expect.objectContaining({ id: 'yt_abc123' }));
    expect(item.title).toBe('Test Song');
    expect(bot.queue.length).toBe(1);
  });

  it('queues behind the current track when something is playing', async () => {
    const bot = fakeBot('playing');
    const { queued } = await downloadAndEnqueue(prisma, bot, 'https://youtu.be/abc123');
    expect(queued).toBe(true);
    expect(bot.play).not.toHaveBeenCalled();
    expect(bot.queue.length).toBe(1);
  });
});
