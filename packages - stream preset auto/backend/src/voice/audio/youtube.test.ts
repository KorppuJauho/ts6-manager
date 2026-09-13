import { describe, it, expect } from 'vitest';
import { pickDownloadedFile } from './youtube.js';

const ID = 'dQw4w9WgXcQ';

describe('pickDownloadedFile', () => {
  it('picks the expected opus file', () => {
    expect(pickDownloadedFile([`${ID}.opus`], ID)).toBe(`${ID}.opus`);
  });

  it('ignores a stale .part file left by an interrupted download', () => {
    // Regression: the old code picked the alphabetically last match, so a
    // leftover "<id>.webm.part" beat the freshly converted "<id>.opus" and a
    // corrupt path was stored in the library.
    expect(pickDownloadedFile([`${ID}.opus`, `${ID}.webm.part`], ID)).toBe(`${ID}.opus`);
  });

  it('ignores temp and metadata artifacts', () => {
    expect(
      pickDownloadedFile([`${ID}.webm.ytdl`, `${ID}.temp.opus`, `${ID}.webp`, `${ID}.info.json`], ID)
    ).toBeNull();
  });

  it('falls back to another audio extension when opus is absent', () => {
    expect(pickDownloadedFile([`${ID}.m4a`], ID)).toBe(`${ID}.m4a`);
  });

  it('prefers opus over other audio files', () => {
    expect(pickDownloadedFile([`${ID}.m4a`, `${ID}.opus`], ID)).toBe(`${ID}.opus`);
  });

  it('returns null when only temp files exist', () => {
    expect(pickDownloadedFile([`${ID}.webm.part`], ID)).toBeNull();
  });

  it('returns null for an empty directory', () => {
    expect(pickDownloadedFile([], ID)).toBeNull();
  });
});
