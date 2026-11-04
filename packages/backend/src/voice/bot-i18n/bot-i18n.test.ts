import { describe, it, expect } from 'vitest';
import { en } from './index.js';

describe('bot message catalogue', () => {
  it('interpolates its arguments rather than dropping them', () => {
    expect(en.nowPlaying('Artist', 'Title')).toContain('Artist');
    expect(en.nowPlaying('Artist', 'Title')).toContain('Title');
    expect(en.queued('Artist', 'Title', 3)).toContain('3');
    expect(en.tvStarting('MTV 3')).toContain('MTV 3');
  });

  it('omits the separator when a track has no artist', () => {
    // Sources without artist metadata previously rendered "undefined - Title".
    const line = en.nowPlaying(undefined, 'Title');
    expect(line).toContain('Title');
    expect(line).not.toContain('undefined');
    expect(line).not.toMatch(/\s-\s*$/);
  });

  it('has a help table that lists only commands the bot handles', () => {
    expect(en.helpHeader.length).toBeGreaterThan(0);
    expect(en.helpLines.length).toBeGreaterThan(10);
    for (const removed of ['!channels', '!move', '!moveall', '!notif']) {
      expect(en.helpLines.join('\n')).not.toContain(removed);
    }
  });
});
