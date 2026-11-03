import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import OpusScript from 'opusscript';

// Each test gets a fresh copy of the module, so the once-per-process warm-up
// flag starts unset.
async function loadPipeline() {
  vi.resetModules();
  return import('./pipeline.js');
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('warmUpOpusEncoder', () => {
  it('encodes 1.5 s of quiet, non-silent audio on a throwaway encoder', async () => {
    const { warmUpOpusEncoder, WARMUP_FRAMES, FRAME_SIZE, FRAME_MS, BYTES_PER_FRAME } = await loadPipeline();
    const encode = vi.spyOn(OpusScript.prototype, 'encode');
    const del = vi.spyOn(OpusScript.prototype, 'delete');

    warmUpOpusEncoder();

    expect(WARMUP_FRAMES * FRAME_MS).toBe(1500);
    expect(encode).toHaveBeenCalledTimes(WARMUP_FRAMES);
    const pcm = encode.mock.calls[0][0];
    expect(pcm.length).toBe(BYTES_PER_FRAME);
    expect(encode.mock.calls[0][1]).toBe(FRAME_SIZE);
    // Not digital silence (libopus would skip most of the encoder), but far
    // below anything audible.
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(64);
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('runs only once per process', async () => {
    const { warmUpOpusEncoder, WARMUP_FRAMES } = await loadPipeline();
    const encode = vi.spyOn(OpusScript.prototype, 'encode');

    warmUpOpusEncoder();
    warmUpOpusEncoder();

    expect(encode).toHaveBeenCalledTimes(WARMUP_FRAMES);
  });

  it('does not throw when the encoder fails, and still frees it', async () => {
    const { warmUpOpusEncoder } = await loadPipeline();
    vi.spyOn(OpusScript.prototype, 'encode').mockImplementation(() => {
      throw new Error('boom');
    });
    const del = vi.spyOn(OpusScript.prototype, 'delete');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => warmUpOpusEncoder()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(del).toHaveBeenCalledTimes(1);
  });
});

describe('AudioPipeline.encodeFrame', () => {
  it('encodes a PCM frame to a CBR Opus packet', async () => {
    const { AudioPipeline, FRAME_SIZE, BYTES_PER_FRAME } = await loadPipeline();
    const pipeline = new AudioPipeline();
    const pcm = Buffer.alloc(BYTES_PER_FRAME);
    for (let i = 0; i < FRAME_SIZE; i++) {
      const v = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 48000));
      pcm.writeInt16LE(v, i * 4);
      pcm.writeInt16LE(v, i * 4 + 2);
    }

    const full = pipeline.encodeFrame(pcm, 100);
    const half = pipeline.encodeFrame(pcm, 50);

    // 96 kbps hard CBR: 96000 / 8 / 50 frames per second = 240 bytes
    expect(Buffer.isBuffer(full)).toBe(true);
    expect(full.length).toBe(240);
    expect(half.length).toBe(240);
  });
});
