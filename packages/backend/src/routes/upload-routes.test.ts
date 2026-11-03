import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { errorHandler } from '../middleware/error-handler.js';
import { AVATAR_MAX_BYTES } from '../voice/bot-avatar.js';

// The music library writes uploads to MUSIC_DIR, read when the module loads,
// so the routers are imported only after it points at a throwaway directory.
const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts6-upload-test-'));
process.env.MUSIC_DIR = musicDir;

const prisma = {
  musicBot: { findUnique: vi.fn() },
  song: { create: vi.fn() },
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { musicBotRoutes } = await import('./music-bots.routes.js');
  const { musicLibraryRoutes } = await import('./music-library.routes.js');

  const app = express();
  app.locals.prisma = prisma;
  app.use((req, _res, next) => {
    (req as any).user = { id: 1, role: 'admin' };
    next();
  });
  app.use('/api/music-bots', musicBotRoutes);
  app.use('/api/servers/:configId/music-library', musicLibraryRoutes);
  app.use(errorHandler);

  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  vi.clearAllMocks();
  for (const name of fs.readdirSync(musicDir)) fs.rmSync(path.join(musicDir, name));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(musicDir, { recursive: true, force: true });
});

function post(url: string, files: { field: string; name: string; bytes: Buffer }[]) {
  const form = new FormData();
  for (const f of files) form.append(f.field, new Blob([new Uint8Array(f.bytes)]), f.name);
  return fetch(`${baseUrl}${url}`, { method: 'POST', body: form });
}

describe('POST /api/music-bots/:id/avatar upload limits', () => {
  it('refuses a file over the size limit as tooBig', async () => {
    const res = await post('/api/music-bots/7/avatar', [
      { field: 'avatar', name: 'big.png', bytes: Buffer.alloc(AVATAR_MAX_BYTES + 1) },
    ]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: 'tooBig' });
    expect(prisma.musicBot.findUnique).not.toHaveBeenCalled();
  });

  it('lets a file exactly at the limit through to the route', async () => {
    prisma.musicBot.findUnique.mockResolvedValue(null);
    const res = await post('/api/music-bots/7/avatar', [
      { field: 'avatar', name: 'edge.png', bytes: Buffer.alloc(AVATAR_MAX_BYTES) },
    ]);
    // Past the upload: the unknown bot is what refuses it.
    expect(res.status).toBe(404);
    expect(prisma.musicBot.findUnique).toHaveBeenCalledWith({ where: { id: 7 }, select: { id: true } });
  });

  it('refuses a second file as a 400, not a server error', async () => {
    const res = await post('/api/music-bots/7/avatar', [
      { field: 'avatar', name: 'a.png', bytes: Buffer.alloc(10) },
      { field: 'avatar', name: 'b.png', bytes: Buffer.alloc(10) },
    ]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Avatar upload failed/);
    expect(prisma.musicBot.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a file in another field as a 400', async () => {
    const res = await post('/api/music-bots/7/avatar', [
      { field: 'file', name: 'a.png', bytes: Buffer.alloc(10) },
    ]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Avatar upload failed/);
  });
});

describe('POST /api/servers/:configId/music-library/upload', () => {
  it('stores an allowed file under a generated name and records it', async () => {
    prisma.song.create.mockImplementation(async ({ data }) => ({ id: 1, ...data }));
    const bytes = Buffer.from('not really an mp3');
    const res = await post('/api/servers/3/music-library/upload', [
      { field: 'file', name: 'Some Artist - Some Title.MP3', bytes },
    ]);
    expect(res.status).toBe(201);

    const { data } = prisma.song.create.mock.calls[0][0];
    expect(data).toMatchObject({
      title: 'Some Title',
      artist: 'Some Artist',
      source: 'local',
      fileSize: bytes.length,
      serverConfigId: 3,
    });
    expect(path.dirname(data.filePath)).toBe(musicDir);
    expect(path.basename(data.filePath)).toMatch(/^[0-9a-f-]{36}\.mp3$/);
    expect(fs.readFileSync(data.filePath)).toEqual(bytes);
  });

  it('refuses a disallowed extension without writing anything', async () => {
    const res = await post('/api/servers/3/music-library/upload', [
      { field: 'file', name: 'tool.exe', bytes: Buffer.from('MZ') },
    ]);
    expect(res.ok).toBe(false);
    expect(prisma.song.create).not.toHaveBeenCalled();
    expect(fs.readdirSync(musicDir)).toEqual([]);
  });
});
