import { describe, it, expect, vi } from 'vitest';
import {
  clampBitrate,
  presetForHeight,
  encodePresetFor,
  isPresetChoice,
  STREAM_PRESETS,
  MAX_STREAM_BITRATE_KBPS,
  AUTO_PRESET,
  DEFAULT_AUTO_MAX_PRESET,
  autoMaxOrDefault,
} from './types.js';

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

describe('presetForHeight', () => {
  it('leaves the request alone when the source can fill it', () => {
    expect(presetForHeight('1080p', 1080)).toBe('1080p');
    expect(presetForHeight('1080p', 2160)).toBe('1080p');
  });

  it('drops to the source resolution rather than upscaling', () => {
    // The case this exists for: a 720p TV channel asked to stream at 1080p.
    expect(presetForHeight('1080p', 720)).toBe('720p');
    expect(presetForHeight('2160p', 1080)).toBe('1080p');
  });

  it('never raises the operator-chosen ceiling', () => {
    expect(presetForHeight('720p', 2160)).toBe('720p');
    expect(presetForHeight('480p', 1080)).toBe('480p');
  });

  it('picks the largest preset the source can fill, not the nearest', () => {
    // 900 lines fills 720p but not 1080p.
    expect(presetForHeight('2160p', 900)).toBe('720p');
    expect(presetForHeight('1440p', 1439)).toBe('1080p');
  });

  it('uses the smallest preset for a source below all of them', () => {
    expect(presetForHeight('1080p', 240)).toBe('480p');
  });

  it('keeps the request when the height is unknown', () => {
    // A probe that could not measure the source is not a reason to guess.
    expect(presetForHeight('1080p', null)).toBe('1080p');
    expect(presetForHeight('1080p', 0)).toBe('1080p');
    expect(presetForHeight('1080p', NaN)).toBe('1080p');
  });

  it('passes an unknown preset through untouched', () => {
    expect(presetForHeight('potato', 720)).toBe('potato');
  });
});

describe('encodePresetFor', () => {
  const probeReturning = (height: number | null) => vi.fn(async () => height);

  it('follows the source under Auto', async () => {
    await expect(encodePresetFor(AUTO_PRESET, probeReturning(720))).resolves.toBe('720p');
    await expect(encodePresetFor(AUTO_PRESET, probeReturning(480))).resolves.toBe('480p');
  });

  it('goes up to 4K by default', async () => {
    expect(DEFAULT_AUTO_MAX_PRESET).toBe('2160p');
    await expect(encodePresetFor(AUTO_PRESET, probeReturning(2160))).resolves.toBe('2160p');
    await expect(encodePresetFor(AUTO_PRESET, probeReturning(1440))).resolves.toBe('1440p');
  });

  // The limit is what keeps upload (bitrate times viewers) within the line.
  it('stops at the configured limit however large the source is', async () => {
    await expect(encodePresetFor(AUTO_PRESET, probeReturning(2160), '1080p')).resolves.toBe('1080p');
    await expect(encodePresetFor(AUTO_PRESET, probeReturning(720), '1080p')).resolves.toBe('720p');
  });

  it('uses the limit when the source cannot be measured', async () => {
    await expect(encodePresetFor(AUTO_PRESET, probeReturning(null), '1080p')).resolves.toBe('1080p');
  });

  it('ignores the limit for a named preset', async () => {
    await expect(encodePresetFor('2160p', probeReturning(480), '720p')).resolves.toBe('2160p');
  });

  // A named preset is the operator's choice of size, and the probe's extra
  // connection is what a single-connection IPTV service refuses.
  it('encodes a named preset as named, without probing', async () => {
    for (const key of Object.keys(STREAM_PRESETS)) {
      const probe = probeReturning(480);
      await expect(encodePresetFor(key, probe)).resolves.toBe(key);
      expect(probe).not.toHaveBeenCalled();
    }
  });
});

describe('isPresetChoice', () => {
  it('accepts every preset and Auto', () => {
    for (const key of Object.keys(STREAM_PRESETS)) expect(isPresetChoice(key)).toBe(true);
    expect(isPresetChoice(AUTO_PRESET)).toBe(true);
  });

  it('rejects anything else, including object keys', () => {
    for (const key of ['', 'AUTO', '999p', 'toString', '__proto__']) expect(isPresetChoice(key)).toBe(false);
  });
});

describe('autoMaxOrDefault', () => {
  // The limit comes from a database column; a stale or hand-edited value
  // must not reach presetForHeight, which would pass it through unchanged.
  it('falls back to the default for anything that is not a preset', () => {
    expect(autoMaxOrDefault('1080p')).toBe('1080p');
    for (const v of ['', 'auto', '999p', '__proto__']) expect(autoMaxOrDefault(v)).toBe(DEFAULT_AUTO_MAX_PRESET);
  });
});
