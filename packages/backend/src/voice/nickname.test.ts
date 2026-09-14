import { describe, it, expect } from 'vitest';
import {
  fitNickname,
  nowPlayingNickname,
  streamingNickname,
  MAX_NICKNAME_LENGTH,
} from './nickname.js';

describe('fitNickname', () => {
  it('leaves a nickname that fits alone', () => {
    expect(fitNickname('MusicBot', ' - ', 'Song')).toBe('MusicBot - Song');
  });

  it('truncates the title, never the bot name', () => {
    const nick = fitNickname('MusicBot', ' - ', 'A Very Long Track Title Indeed');
    expect(nick.length).toBeLessThanOrEqual(MAX_NICKNAME_LENGTH);
    expect(nick.startsWith('MusicBot - ')).toBe(true);
    expect(nick.endsWith('…')).toBe(true);
  });

  it('keeps the suffix on a truncated title', () => {
    const nick = fitNickname('Bot', " - Streaming '", 'A Channel With A Long Name', "'");
    expect(nick.length).toBeLessThanOrEqual(MAX_NICKNAME_LENGTH);
    expect(nick.endsWith("…'")).toBe(true);
  });

  it('falls back to the bare prefix when nothing else fits', () => {
    const prefix = 'A'.repeat(MAX_NICKNAME_LENGTH);
    expect(fitNickname(prefix, ' - ', 'Title')).toBe(prefix);
  });
});

describe('streamingNickname', () => {
  it('uses the quoted form when it fits', () => {
    expect(streamingNickname('Boten Anna', 'MTV3')).toBe("Boten Anna - Streaming 'MTV3'");
  });

  it('stays within the TeamSpeak limit', () => {
    expect(streamingNickname('Boten Anna', 'MTV3').length).toBeLessThanOrEqual(MAX_NICKNAME_LENGTH);
  });

  // " - Streaming ''" alone is 15 characters. A long bot name spends the
  // budget on punctuation, leaving a nickname that says a stream is running
  // without saying what of — the compact form says more in the same space.
  it('switches to the compact form when the quoted one would crowd out the title', () => {
    const nick = streamingNickname('SomeLongBotName', 'Channel One');
    expect(nick.length).toBeLessThanOrEqual(MAX_NICKNAME_LENGTH);
    expect(nick).toContain('▶');
    expect(nick).toContain('Chan');
  });
});

describe('nowPlayingNickname', () => {
  it('keeps the music note separator', () => {
    expect(nowPlayingNickname('MusicBot', 'Song')).toBe('MusicBot ♪ Song');
  });
});
