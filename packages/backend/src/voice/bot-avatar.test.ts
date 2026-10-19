import { describe, expect, it } from 'vitest';
import { spawnSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  AVATAR_MAX_BYTES,
  checkAvatarUpload,
  fitInside,
  imageSize,
  loadTeamSpeakAvatar,
  prepareAvatar,
  readOriginalAvatar,
  removeBotAvatarFiles,
  resizeArgs,
  serverAvatarPath,
  sniffImage,
  storeAvatarUpload,
  DEFAULT_AVATAR_PATH,
} from './bot-avatar.js';

// Minimal headers: enough for the signature and the size, which is all the
// checks read before FFmpeg sees the file.
function pngHeader(width: number, height: number, total = 64): Buffer {
  const buf = Buffer.alloc(total);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gifHeader(width: number, height: number, total = 32): Buffer {
  const buf = Buffer.alloc(total);
  buf.write('GIF89a', 0, 'latin1');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** SOI, an APP0 segment to walk past, then SOF0 with the size. */
function jpegHeader(width: number, height: number, sof = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sofSeg = Buffer.alloc(19);
  sofSeg[0] = 0xff; sofSeg[1] = sof;
  sofSeg.writeUInt16BE(17, 2);
  sofSeg[4] = 8;
  sofSeg.writeUInt16BE(height, 5);
  sofSeg.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sofSeg, Buffer.alloc(16)]);
}

describe('sniffImage', () => {
  it('recognises PNG, JPEG and GIF by their bytes', () => {
    expect(sniffImage(pngHeader(10, 10))).toBe('png');
    expect(sniffImage(jpegHeader(10, 10))).toBe('jpeg');
    expect(sniffImage(gifHeader(10, 10))).toBe('gif');
    expect(sniffImage(Buffer.from('GIF87a....'))).toBe('gif');
  });

  it('refuses anything else, whatever it would be called', () => {
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBeNull();
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('imageSize', () => {
  it('reads the size from each format', () => {
    expect(imageSize(pngHeader(640, 480), 'png')).toEqual({ width: 640, height: 480 });
    expect(imageSize(gifHeader(1000, 20), 'gif')).toEqual({ width: 1000, height: 20 });
    expect(imageSize(jpegHeader(1920, 1080), 'jpeg')).toEqual({ width: 1920, height: 1080 });
  });

  it('finds a progressive JPEG frame (SOF2) and skips DHT', () => {
    expect(imageSize(jpegHeader(400, 300, 0xc2), 'jpeg')).toEqual({ width: 400, height: 300 });
    expect(imageSize(jpegHeader(400, 300, 0xc4), 'jpeg')).toBeNull();
  });

  it('gives up on a truncated or malformed header', () => {
    expect(imageSize(pngHeader(10, 10).subarray(0, 20), 'png')).toBeNull();
    const notIhdr = pngHeader(10, 10);
    notIhdr.write('IDAT', 12, 'latin1');
    expect(imageSize(notIhdr, 'png')).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]), 'jpeg')).toBeNull();
  });
});

describe('checkAvatarUpload', () => {
  it('accepts a PNG, JPEG or GIF up to 200 KB', () => {
    expect(checkAvatarUpload(pngHeader(64, 64))).toEqual({ ok: true, kind: 'png', width: 64, height: 64 });
    expect(checkAvatarUpload(pngHeader(64, 64, AVATAR_MAX_BYTES))).toMatchObject({ ok: true });
  });

  it('refuses a file over 200 KB, before looking at it', () => {
    expect(checkAvatarUpload(pngHeader(64, 64, AVATAR_MAX_BYTES + 1))).toEqual({ ok: false, reason: 'tooBig' });
  });

  it('refuses an empty file, a non-image, and an image without a readable size', () => {
    expect(checkAvatarUpload(Buffer.alloc(0))).toEqual({ ok: false, reason: 'empty' });
    expect(checkAvatarUpload(Buffer.from('#!/bin/sh\necho hi\n'))).toEqual({ ok: false, reason: 'notImage' });
    expect(checkAvatarUpload(pngHeader(0, 64))).toEqual({ ok: false, reason: 'unreadable' });
    expect(checkAvatarUpload(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toEqual({ ok: false, reason: 'unreadable' });
  });
});

describe('fitInside', () => {
  it('leaves an image that fits alone', () => {
    expect(fitInside(300, 300)).toEqual({ width: 300, height: 300 });
    expect(fitInside(180, 120)).toEqual({ width: 180, height: 120 });
  });

  it('shrinks to fit 300×300 with the shape kept', () => {
    expect(fitInside(600, 400)).toEqual({ width: 300, height: 200 });
    expect(fitInside(400, 1200)).toEqual({ width: 100, height: 300 });
    expect(fitInside(301, 301)).toEqual({ width: 300, height: 300 });
  });

  it('never rounds a side to zero', () => {
    expect(fitInside(10000, 1)).toEqual({ width: 300, height: 1 });
  });
});

describe('resizeArgs', () => {
  it('writes one frame of a PNG or JPEG in its own format', () => {
    const png = resizeArgs('png', 300, 200);
    expect(png).toEqual(expect.arrayContaining(['-f', 'png_pipe', '-i', 'pipe:0', '-frames:v', '1', 'png']));
    expect(png.join(' ')).toContain('scale=300:200');
    const jpeg = resizeArgs('jpeg', 300, 200);
    expect(jpeg).toEqual(expect.arrayContaining(['jpeg_pipe', 'mjpeg', '-frames:v', '1']));
  });

  it('keeps every frame of a GIF, through a palette of the scaled frames', () => {
    const gif = resizeArgs('gif', 120, 300);
    expect(gif).not.toContain('-frames:v');
    const graph = gif[gif.indexOf('-filter_complex') + 1];
    expect(graph).toContain('scale=120:300');
    expect(graph).toContain('palettegen');
    expect(graph).toContain('paletteuse');
    expect(gif.slice(-3)).toEqual(['-f', 'gif', 'pipe:1']);
  });
});

describe('prepareAvatar', () => {
  const fakeRun = (out: Buffer) => {
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); return out; };
    return { run, calls };
  };

  it('uploads an image that fits as it is, without running FFmpeg', async () => {
    const data = pngHeader(300, 120);
    const check = checkAvatarUpload(data);
    if (!check.ok) throw new Error('fixture');
    const { run, calls } = fakeRun(Buffer.alloc(0));
    expect(await prepareAvatar(data, check, run)).toBe(data);
    expect(calls).toHaveLength(0);
  });

  it('shrinks a larger one to fit', async () => {
    const data = gifHeader(900, 600);
    const check = checkAvatarUpload(data);
    if (!check.ok) throw new Error('fixture');
    const out = gifHeader(300, 200);
    const { run, calls } = fakeRun(out);
    expect(await prepareAvatar(data, check, run)).toBe(out);
    expect(calls[0].join(' ')).toContain('scale=300:200');
  });

  it('refuses a result that is not the same kind of image, or is over 200 KB', async () => {
    const data = pngHeader(900, 900);
    const check = checkAvatarUpload(data);
    if (!check.ok) throw new Error('fixture');
    await expect(prepareAvatar(data, check, fakeRun(gifHeader(300, 300)).run))
      .rejects.toMatchObject({ reason: 'resizeFailed' });
    await expect(prepareAvatar(data, check, fakeRun(pngHeader(300, 300, AVATAR_MAX_BYTES + 1)).run))
      .rejects.toMatchObject({ reason: 'tooBigAfterResize' });
    await expect(prepareAvatar(data, check, async () => { throw new Error('ffmpeg exited 1'); }))
      .rejects.toMatchObject({ reason: 'resizeFailed' });
  });
});

describe('storage', () => {
  async function tempDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'bot-avatar-'));
  }

  it('keeps the original for the web UI and the shrunk copy for TeamSpeak', async () => {
    const dir = await tempDir();
    const original = pngHeader(600, 600);
    const shrunk = pngHeader(300, 300);
    const stored = await storeAvatarUpload(5, original, { dir, run: async () => shrunk });
    expect(stored).toEqual({ ok: true, file: 'bot-5.png', md5: createHash('md5').update(shrunk).digest('hex') });

    const setting = { avatarMode: 'upload', avatarFile: 'bot-5.png' };
    expect(await readOriginalAvatar(setting, dir)).toEqual(original);
    expect(await loadTeamSpeakAvatar(setting, dir)).toEqual({ data: shrunk, md5: createHash('md5').update(shrunk).digest('hex') });
  });

  it('replaces an earlier upload of another type, and removes all of a bot\'s files', async () => {
    const dir = await tempDir();
    await storeAvatarUpload(5, pngHeader(64, 64), { dir });
    await storeAvatarUpload(6, gifHeader(64, 64), { dir });
    await storeAvatarUpload(5, gifHeader(64, 64), { dir });
    expect((await fs.readdir(dir)).sort()).toEqual(['bot-5.gif', 'bot-5.teamspeak.gif', 'bot-6.gif', 'bot-6.teamspeak.gif']);
    await removeBotAvatarFiles(5, dir);
    expect((await fs.readdir(dir)).sort()).toEqual(['bot-6.gif', 'bot-6.teamspeak.gif']);
  });

  it('stores nothing for a refused upload', async () => {
    const dir = await tempDir();
    expect(await storeAvatarUpload(5, Buffer.from('not an image'), { dir })).toEqual({ ok: false, reason: 'notImage' });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('serves the bundled icon as the default, and nothing for none', async () => {
    const icon = await fs.readFile(DEFAULT_AVATAR_PATH);
    expect(sniffImage(icon)).toBe('png');
    const size = imageSize(icon, 'png')!;
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(300);
    expect(await readOriginalAvatar({ avatarMode: 'default', avatarFile: null })).toEqual(icon);
    expect((await loadTeamSpeakAvatar({ avatarMode: 'default', avatarFile: null }))?.data).toEqual(icon);
    expect(await readOriginalAvatar({ avatarMode: 'none', avatarFile: 'bot-1.png' })).toBeNull();
    expect(await loadTeamSpeakAvatar({ avatarMode: 'none', avatarFile: 'bot-1.png' })).toBeNull();
  });

  it('never follows a stored name that is not one it wrote', async () => {
    await expect(loadTeamSpeakAvatar({ avatarMode: 'upload', avatarFile: '../../etc/passwd' })).rejects.toThrow();
    expect(await readOriginalAvatar({ avatarMode: 'upload', avatarFile: '../secret.png' })).toBeNull();
  });
});

describe('serverAvatarPath', () => {
  it('uses the name the server reports', () => {
    const name = 'a'.repeat(40);
    expect(serverAvatarPath(name, 'ignored')).toBe(`/avatar_${name}`);
  });

  it('else works it out from the unique identifier: each half-byte a letter a-p', () => {
    // 0x00 0x1f 0xff → "aa" "bp" "pp"
    const uid = Buffer.concat([Buffer.from([0x00, 0x1f, 0xff]), Buffer.alloc(17)]).toString('base64');
    expect(serverAvatarPath(undefined, uid)).toBe(`/avatar_aabppp${'a'.repeat(34)}`);
  });

  it('gives no path for names it cannot trust', () => {
    expect(serverAvatarPath('../../x', undefined)).toBeNull();
    expect(serverAvatarPath(undefined, 'not base64!')).toBeNull();
  });
});

// The real FFmpeg, where one is installed (the backend image has it).
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function ffmpegOut(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    const out: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => out.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exit ${code}`))));
  });
}

/** Image descriptors in a GIF: one per frame. Walks the blocks rather than searching for 0x2c. */
function gifFrameCount(buf: Buffer): number {
  let i = 13;
  if (buf[10] & 0x80) i += 3 * (1 << ((buf[10] & 7) + 1));
  let frames = 0;
  const skipSubBlocks = () => { while (buf[i] !== 0) i += buf[i] + 1; i++; };
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x3b) break;
    if (b === 0x21) { i += 2; skipSubBlocks(); continue; }
    if (b === 0x2c) {
      frames++;
      const packed = buf[i + 9];
      i += 10;
      if (packed & 0x80) i += 3 * (1 << ((packed & 7) + 1));
      i++; // LZW minimum code size
      skipSubBlocks();
      continue;
    }
    throw new Error(`unexpected GIF block 0x${b.toString(16)} at ${i}`);
  }
  return frames;
}

describe.skipIf(!hasFfmpeg)('prepareAvatar with FFmpeg', () => {
  const src = (size: string) => ['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=5`];

  it('shrinks a PNG to fit 300×300', async () => {
    const png = await ffmpegOut([...src('640x480'), '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']);
    const check = checkAvatarUpload(png);
    if (!check.ok) throw new Error(`fixture refused: ${check.reason}`);
    const out = await prepareAvatar(png, check);
    expect(sniffImage(out)).toBe('png');
    expect(imageSize(out, 'png')).toEqual({ width: 300, height: 225 });
  });

  it('shrinks a JPEG of odd size to fit 300×300', async () => {
    const jpeg = await ffmpegOut([...src('333x999'), '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
    const check = checkAvatarUpload(jpeg);
    if (!check.ok) throw new Error(`fixture refused: ${check.reason}`);
    const out = await prepareAvatar(jpeg, check);
    expect(sniffImage(out)).toBe('jpeg');
    expect(imageSize(out, 'jpeg')).toEqual({ width: 100, height: 300 });
  });

  it('shrinks an animated GIF and keeps its frames', async () => {
    const gif = await ffmpegOut([...src('480x320'), '-frames:v', '6', '-f', 'gif', 'pipe:1']);
    expect(gifFrameCount(gif)).toBe(6);
    const check = checkAvatarUpload(gif);
    if (!check.ok) throw new Error(`fixture refused: ${check.reason}`);
    const out = await prepareAvatar(gif, check);
    expect(sniffImage(out)).toBe('gif');
    expect(imageSize(out, 'gif')).toEqual({ width: 300, height: 200 });
    expect(gifFrameCount(out)).toBe(6);
  });

  it('turns a file that only looks like an image into a refusal, not a crash', async () => {
    const fake = Buffer.concat([pngHeader(900, 900), Buffer.alloc(200)]);
    const check = checkAvatarUpload(fake);
    if (!check.ok) throw new Error('fixture');
    await expect(prepareAvatar(fake, check)).rejects.toMatchObject({ reason: 'resizeFailed' });
  });
});
