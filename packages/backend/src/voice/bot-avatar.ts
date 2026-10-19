import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// A music bot's TeamSpeak avatar.
//
// TeamSpeak takes an avatar as a file upload into the virtual server's own
// files (channel 0) named "/avatar"; the server keeps it per identity as
// "/avatar_<the client_unique_identifier's bytes as letters a-p>". Setting
// client_flag_avatar to the file's MD5 then tells every client to show it; an
// empty flag shows none. Checked against TeamSpeak 6.0.0-beta13: there a
// client cannot delete its own avatar file (ftdeletefile answers 1540
// "convert error", with every file transfer permission granted), so removing
// an avatar rests on clearing the flag.
//
// The server checks only the file size (the "max avatar file size" permission,
// stock 200 KB; 0 allows no avatar at all, refused with 2565 "invalid size"),
// not the pixels, but TeamSpeak 6 clients show an avatar larger than about
// 320×320 as blank. So an upload is shrunk to fit inside 300×300 before it
// goes to TeamSpeak, while the web UI keeps and shows the original.

export const AVATAR_MODES = ['upload', 'default', 'none'] as const;
export type AvatarMode = (typeof AVATAR_MODES)[number];
export const isAvatarMode = (v: unknown): v is AvatarMode =>
  typeof v === 'string' && (AVATAR_MODES as readonly string[]).includes(v);

/** The largest upload accepted, matching the server's stock avatar size limit. */
export const AVATAR_MAX_BYTES = 200 * 1024;
/** Uploads with a side over this are shrunk to fit inside a square of it. */
export const AVATAR_MAX_SIDE = 300;
/** The name a client uploads its avatar under; the server stores it per identity. */
export const AVATAR_UPLOAD_NAME = '/avatar';

export type ImageKind = 'png' | 'jpeg' | 'gif';
export const IMAGE_MIME: Record<ImageKind, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' };
const IMAGE_EXT: Record<ImageKind, string> = { png: 'png', jpeg: 'jpg', gif: 'gif' };

/** What the bytes are, by their signature — never by a file name or a client-sent type. */
export function sniffImage(buf: Uint8Array): ImageKind | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6) {
    const head = Buffer.from(buf.subarray(0, 6)).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  return null;
}

/** An image's size in pixels from its header, or null when the header cannot be read. */
export function imageSize(buf: Uint8Array, kind: ImageKind): { width: number; height: number } | null {
  const u16be = (i: number) => (buf[i] << 8) | buf[i + 1];
  if (kind === 'png') {
    // The first chunk must be IHDR: width and height at bytes 16-23.
    if (buf.length < 24 || Buffer.from(buf.subarray(12, 16)).toString('latin1') !== 'IHDR') return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (kind === 'gif') {
    if (buf.length < 10) return null;
    return { width: buf[6] | (buf[7] << 8), height: buf[8] | (buf[9] << 8) };
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    const length = u16be(i + 2);
    // SOF0-SOF15, except DHT (c4), JPG (c8) and DAC (cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: u16be(i + 7), height: u16be(i + 5) };
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

export type AvatarRejection = 'empty' | 'tooBig' | 'notImage' | 'unreadable';

export type AvatarCheck =
  | { ok: true; kind: ImageKind; width: number; height: number }
  | { ok: false; reason: AvatarRejection };

/** Checks an uploaded avatar: a PNG, JPEG or GIF by content, at most AVATAR_MAX_BYTES, with a readable size. */
export function checkAvatarUpload(buf: Uint8Array): AvatarCheck {
  if (buf.length === 0) return { ok: false, reason: 'empty' };
  if (buf.length > AVATAR_MAX_BYTES) return { ok: false, reason: 'tooBig' };
  const kind = sniffImage(buf);
  if (!kind) return { ok: false, reason: 'notImage' };
  const size = imageSize(buf, kind);
  if (!size || size.width < 1 || size.height < 1) return { ok: false, reason: 'unreadable' };
  return { ok: true, kind, ...size };
}

/** The size that fits `width`×`height` inside `max`×`max` with its shape kept; never below 1 px. */
export function fitInside(width: number, height: number, max = AVATAR_MAX_SIDE): { width: number; height: number } {
  if (width <= max && height <= max) return { width, height };
  const scale = max / Math.max(width, height);
  return {
    width: Math.max(1, Math.min(max, Math.round(width * scale))),
    height: Math.max(1, Math.min(max, Math.round(height * scale))),
  };
}

/**
 * FFmpeg's arguments to scale an image read from stdin to `width`×`height`,
 * written to stdout in the same format. A GIF keeps every frame and its timing,
 * through a palette made from the scaled frames (scaling blends colours the
 * original palette does not have).
 */
export function resizeArgs(kind: ImageKind, width: number, height: number): string[] {
  const scale = `scale=${width}:${height}:flags=lanczos`;
  const input = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (kind === 'gif') {
    return [
      ...input, '-f', 'gif', '-i', 'pipe:0',
      '-filter_complex', `[0:v]${scale},split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse`,
      '-loop', '0', '-f', 'gif', 'pipe:1',
    ];
  }
  const demuxer = kind === 'png' ? 'png_pipe' : 'jpeg_pipe';
  const codec = kind === 'png' ? ['-c:v', 'png'] : ['-c:v', 'mjpeg', '-q:v', '2'];
  return [
    ...input, '-f', demuxer, '-i', 'pipe:0',
    '-vf', scale, '-frames:v', '1', ...codec, '-f', 'image2pipe', 'pipe:1',
  ];
}

const RESIZE_TIMEOUT_MS = 30_000;
const RESIZE_MAX_OUTPUT = 4 * 1024 * 1024;

function runFfmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = '';
    let failed = false;
    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      proc.kill('SIGKILL');
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('ffmpeg took too long to resize the avatar')), RESIZE_TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > RESIZE_MAX_OUTPUT) return fail(new Error('ffmpeg produced an oversized avatar'));
      out.push(chunk);
    });
    proc.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 2000) stderr += chunk.toString(); });
    proc.on('error', (err) => fail(new Error(`ffmpeg could not run: ${err.message}`)));
    proc.on('close', (code) => {
      if (failed) return;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg failed to resize the avatar (exit ${code}): ${stderr.trim().slice(0, 300)}`));
      resolve(Buffer.concat(out));
    });
    // EPIPE when ffmpeg quits early surfaces through 'close' with its stderr.
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
  });
}

export class AvatarPrepareError extends Error {
  constructor(message: string, public readonly reason: 'tooBigAfterResize' | 'resizeFailed') {
    super(message);
    this.name = 'AvatarPrepareError';
  }
}

/**
 * The file TeamSpeak gets for a checked upload: the upload itself when it
 * already fits inside AVATAR_MAX_SIDE, else a copy shrunk to fit.
 */
export async function prepareAvatar(
  data: Buffer,
  check: Extract<AvatarCheck, { ok: true }>,
  run: (args: string[], input: Buffer) => Promise<Buffer> = runFfmpeg,
): Promise<Buffer> {
  const target = fitInside(check.width, check.height);
  if (target.width === check.width && target.height === check.height) return data;
  let out: Buffer;
  try {
    out = await run(resizeArgs(check.kind, target.width, target.height), data);
  } catch (err: any) {
    throw new AvatarPrepareError(err.message, 'resizeFailed');
  }
  if (sniffImage(out) !== check.kind) {
    throw new AvatarPrepareError('ffmpeg did not produce an image of the same type', 'resizeFailed');
  }
  // A re-encoded GIF can come out larger than its original.
  if (out.length > AVATAR_MAX_BYTES) {
    throw new AvatarPrepareError('the avatar is still over 200 KB after shrinking it to 300×300', 'tooBigAfterResize');
  }
  return out;
}

/** The value of client_flag_avatar: the uploaded file's MD5. */
export function avatarFlag(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}

/**
 * Where the server keeps a client's avatar: "/avatar_" and the name a server
 * reports as client_base64HashClientUID, else that name worked out from the
 * client's unique identifier (its bytes, each half-byte a letter a-p).
 * TeamSpeak 6 sends no client_base64HashClientUID; the worked-out name is the
 * one its avatar files carry.
 */
export function serverAvatarPath(base64HashClientUID: string | undefined, uid: string | undefined): string | null {
  if (base64HashClientUID && /^[a-p]{32,128}$/.test(base64HashClientUID)) return `/avatar_${base64HashClientUID}`;
  if (uid && /^[A-Za-z0-9+/]{20,88}={0,2}$/.test(uid)) {
    let name = '';
    for (const b of Buffer.from(uid, 'base64')) name += String.fromCharCode(97 + (b >> 4), 97 + (b & 15));
    return `/avatar_${name}`;
  }
  return null;
}

// --- Storage ---
//
// Uploads live in the backend's data directory, which is the persistent
// volume in Docker. Names come from the bot id only, never from the upload.

/** The bundled app icon that new bots use. 180×180, so it needs no resizing. */
export const DEFAULT_AVATAR_PATH = fileURLToPath(new URL('../../assets/default-bot-avatar.png', import.meta.url));

export function avatarDir(): string {
  return path.resolve('data', 'bot-avatars');
}

/** The original upload, as the web UI shows it. */
export const originalFileName = (botId: number, kind: ImageKind) => `bot-${botId}.${IMAGE_EXT[kind]}`;
/** What TeamSpeak gets: the original, or its shrunk copy. */
export const teamspeakFileName = (originalFile: string) => originalFile.replace(/\.([a-z]+)$/, '.teamspeak.$1');

/** Removes every stored avatar file of a bot. */
export async function removeBotAvatarFiles(botId: number, dir = avatarDir()): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const prefix = `bot-${botId}.`;
  await Promise.all(names.filter((n) => n.startsWith(prefix)).map((n) => fs.rm(path.join(dir, n), { force: true })));
}

/** Stores a checked upload and what TeamSpeak gets for it. Returns the original's file name and the TeamSpeak file's MD5. */
export async function saveBotAvatar(
  botId: number,
  original: Buffer,
  prepared: Buffer,
  kind: ImageKind,
  dir = avatarDir(),
): Promise<{ file: string; md5: string }> {
  await fs.mkdir(dir, { recursive: true });
  await removeBotAvatarFiles(botId, dir);
  const file = originalFileName(botId, kind);
  await fs.writeFile(path.join(dir, teamspeakFileName(file)), prepared);
  await fs.writeFile(path.join(dir, file), original);
  return { file, md5: avatarFlag(prepared) };
}

export type AvatarUploadResult =
  | { ok: true; file: string; md5: string }
  | { ok: false; reason: AvatarRejection | AvatarPrepareError['reason']; detail?: string };

/** Checks, prepares and stores an upload. Nothing is stored for a refused one. */
export async function storeAvatarUpload(
  botId: number,
  data: Buffer,
  opts: { dir?: string; run?: (args: string[], input: Buffer) => Promise<Buffer> } = {},
): Promise<AvatarUploadResult> {
  const check = checkAvatarUpload(data);
  if (!check.ok) return check;
  let prepared: Buffer;
  try {
    prepared = await prepareAvatar(data, check, opts.run);
  } catch (err) {
    if (err instanceof AvatarPrepareError) return { ok: false, reason: err.reason, detail: err.message };
    throw err;
  }
  const saved = await saveBotAvatar(botId, data, prepared, check.kind, opts.dir);
  return { ok: true, ...saved };
}

export interface BotAvatarSetting {
  avatarMode: string;
  avatarFile: string | null;
}

/** A stored name is trusted only in the exact form saveBotAvatar writes. */
const STORED_NAME = /^bot-\d+\.(png|jpg|gif)$/;

/** The image the web UI shows for a bot's setting (the original upload, or the default icon), or null for none. */
export async function readOriginalAvatar(setting: BotAvatarSetting, dir = avatarDir()): Promise<Buffer | null> {
  if (setting.avatarMode === 'default') return fs.readFile(DEFAULT_AVATAR_PATH);
  if (setting.avatarMode === 'upload' && setting.avatarFile && STORED_NAME.test(setting.avatarFile)) {
    return fs.readFile(path.join(dir, setting.avatarFile));
  }
  return null;
}

/** The file to upload to TeamSpeak for a bot's setting, with its flag; null for none. */
export async function loadTeamSpeakAvatar(
  setting: BotAvatarSetting,
  dir = avatarDir(),
): Promise<{ data: Buffer; md5: string } | null> {
  let data: Buffer;
  if (setting.avatarMode === 'default') {
    data = await fs.readFile(DEFAULT_AVATAR_PATH);
  } else if (setting.avatarMode === 'upload') {
    if (!setting.avatarFile || !STORED_NAME.test(setting.avatarFile)) throw new Error('no uploaded avatar is stored for this bot');
    data = await fs.readFile(path.join(dir, teamspeakFileName(setting.avatarFile)));
  } else {
    return null;
  }
  return { data, md5: avatarFlag(data) };
}
