import { describe, it, expect } from 'vitest';
import { clampBitrate, STREAM_PRESETS, MAX_STREAM_BITRATE_KBPS } from './types.js';

describe('clampBitrate', () => {
  it('leaves a bitrate under the ceiling alone', () => {
    expect(clampBitrate('4500k')).toBe('4500k');
    expect(clampBitrate('9500k')).toBe('9500k');
  });

  it('caps one over the ceiling', () => {
    expect(clampBitrate('18000k')).toBe('10000k');
    expect(clampBitrate('20M')).toBe('10000k');
  });

  it('understands FFmpeg unit suffixes', () => {
    // 8M is under the ceiling; 12M is over it.
    expect(clampBitrate('8M')).toBe('8M');
    expect(clampBitrate('12M')).toBe('10000k');
  });

  it('treats a bare number as bits per second', () => {
    expect(clampBitrate('4500000')).toBe('4500000');
    expect(clampBitrate('20000000')).toBe('10000k');
  });

  it('passes through what it cannot parse rather than guessing', () => {
    // The sidecar validates the format; rewriting an unknown shape here would
    // turn a clear rejection into a confusing silent change.
    expect(clampBitrate('fast')).toBe('fast');
    expect(clampBitrate('')).toBe('');
  });
});

describe('stream presets', () => {
  it('keeps every preset under the TeamSpeak ceiling', () => {
    // A preset over the cap gets its stream dropped by the server, which
    // presents as an encoder failure and is miserable to diagnose.
    for (const [key, preset] of Object.entries(STREAM_PRESETS)) {
      const kbps = Number(preset.bitrate.replace(/[kK]$/, ''));
      expect(kbps, `preset ${key} (${preset.bitrate})`).toBeLessThanOrEqual(MAX_STREAM_BITRATE_KBPS);
    }
  });
});
