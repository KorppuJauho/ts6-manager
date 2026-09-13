import { describe, it, expect, afterEach } from 'vitest';
import {
  parseProbedHeight,
  probeVideoHeight,
  probeTimeoutMs,
  DEFAULT_PROBE_TIMEOUT_MS,
} from './probe.js';

describe('parseProbedHeight', () => {
  it('reads the height of the first video stream', () => {
    expect(parseProbedHeight('{"streams":[{"width":1280,"height":720}]}')).toBe(720);
  });

  it('skips a stream with no usable dimensions', () => {
    // ffprobe reports height 0 for a stream it could not measure.
    const out = '{"streams":[{"width":0,"height":0},{"width":1920,"height":1080}]}';
    expect(parseProbedHeight(out)).toBe(1080);
  });

  it('returns null when there is no video stream', () => {
    expect(parseProbedHeight('{"streams":[]}')).toBeNull();
  });

  it('returns null rather than throwing on unparseable output', () => {
    expect(parseProbedHeight('')).toBeNull();
    expect(parseProbedHeight('ffprobe: command not found')).toBeNull();
    expect(parseProbedHeight('{"streams":"nope"}')).toBeNull();
  });
});

describe('probeVideoHeight', () => {
  // ffprobe resolves an input by protocol, so a non-http source must be
  // refused before it is spawned rather than relying on the whitelist alone.
  it('refuses a source that is not http(s) without spawning ffprobe', async () => {
    await expect(probeVideoHeight('file:///etc/passwd')).resolves.toBeNull();
    await expect(probeVideoHeight('concat:/etc/passwd')).resolves.toBeNull();
    await expect(probeVideoHeight('-i')).resolves.toBeNull();
    await expect(probeVideoHeight('')).resolves.toBeNull();
  });
});

describe('probeTimeoutMs', () => {
  const original = process.env.STREAM_PROBE_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.STREAM_PROBE_TIMEOUT_MS;
    else process.env.STREAM_PROBE_TIMEOUT_MS = original;
  });

  it('defaults when unset', () => {
    delete process.env.STREAM_PROBE_TIMEOUT_MS;
    expect(probeTimeoutMs()).toBe(DEFAULT_PROBE_TIMEOUT_MS);
  });

  it('honours an explicit timeout', () => {
    process.env.STREAM_PROBE_TIMEOUT_MS = '2000';
    expect(probeTimeoutMs()).toBe(2000);
  });

  it('treats a nonsense value as unset rather than as zero', () => {
    // Zero disables probing, so a typo must not silently switch it off.
    process.env.STREAM_PROBE_TIMEOUT_MS = 'soon';
    expect(probeTimeoutMs()).toBe(DEFAULT_PROBE_TIMEOUT_MS);
    process.env.STREAM_PROBE_TIMEOUT_MS = '-5';
    expect(probeTimeoutMs()).toBe(DEFAULT_PROBE_TIMEOUT_MS);
  });

  it('does not spawn ffprobe when disabled', async () => {
    process.env.STREAM_PROBE_TIMEOUT_MS = '0';
    await expect(probeVideoHeight('https://example.com/stream.m3u8')).resolves.toBeNull();
  });
});
