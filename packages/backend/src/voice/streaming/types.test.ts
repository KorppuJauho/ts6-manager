import { describe, it, expect } from 'vitest';
import {
  clampBitrate,
  presetForHeight,
  presetForCodec,
  framerateForCodec,
  STREAM_PRESETS,
  MAX_STREAM_BITRATE_KBPS,
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

describe('presetForCodec', () => {
  // Observed on a real client: the offer carried level 4.0 for 1080p and the
  // answer came back 42e01f — level 3.1, which stops at 1280x720. Sending
  // 1080p H.264 after that is sending what the receiver said it cannot decode.
  it('caps H.264 at the level the TeamSpeak client answers with', () => {
    expect(presetForCodec('1080p', 'h264')).toBe('720p');
    expect(presetForCodec('1440p', 'h264')).toBe('720p');
    expect(presetForCodec('2160p', 'h264')).toBe('720p');
  });

  it('leaves H.264 alone at or below the ceiling', () => {
    expect(presetForCodec('720p', 'h264')).toBe('720p');
    expect(presetForCodec('480p', 'h264')).toBe('480p');
  });

  it('does not cap VP8 or VP9, which carry no level in their SDP', () => {
    expect(presetForCodec('2160p', 'vp8')).toBe('2160p');
    expect(presetForCodec('1080p', 'vp9')).toBe('1080p');
  });

  it('passes an unknown preset through untouched', () => {
    expect(presetForCodec('potato', 'h264')).toBe('potato');
  });

  // The cap and the source probe compose: whichever binds harder wins, and
  // neither can raise the other's result.
  it('composes with presetForHeight in either order', () => {
    expect(presetForCodec(presetForHeight('1080p', 1080), 'h264')).toBe('720p');
    expect(presetForCodec(presetForHeight('1080p', 480), 'h264')).toBe('480p');
  });
});

describe('framerateForCodec', () => {
  it('holds H.264 to what level 3.1 sustains at 720p', () => {
    expect(framerateForCodec(60, 'h264')).toBe(30);
    expect(framerateForCodec(30, 'h264')).toBe(30);
    expect(framerateForCodec(24, 'h264')).toBe(24);
  });

  it('leaves other codecs alone', () => {
    expect(framerateForCodec(60, 'vp9')).toBe(60);
  });
});
