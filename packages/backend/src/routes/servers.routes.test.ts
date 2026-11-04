import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { errorHandler } from '../middleware/error-handler.js';
import { requireServerAccess } from '../middleware/server-access.js';
import { serverRoutes } from './servers.routes.js';

const prisma = {
  tsServerConfig: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  userServerAccess: { findUnique: vi.fn() },
  musicBot: { findMany: vi.fn() },
};
const voiceBotManager = { removeBot: vi.fn(), applyServerHost: vi.fn() };
let role: 'admin' | 'viewer' = 'admin';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.locals.prisma = prisma;
  app.locals.voiceBotManager = voiceBotManager;
  app.use((req, _res, next) => {
    (req as any).user = { id: 7, role };
    next();
  });
  app.use('/api/servers', serverRoutes);
  app.get('/api/servers/:configId/probe', requireServerAccess(), (_req, res) => { res.json({ ok: true }); });
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  vi.resetAllMocks();
  role = 'admin';
  vi.spyOn(console, 'error').mockImplementation(() => { });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function send(method: string, url: string, body?: unknown) {
  return fetch(`${baseUrl}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('server records are name and host', () => {
  it('creates a server from name and host, trimmed', async () => {
    prisma.tsServerConfig.create.mockResolvedValue({ id: 3, name: 'Home', host: 'ts.example.com' });
    const res = await send('POST', '/api/servers', { name: ' Home ', host: ' ts.example.com ', apiKey: 'ignored', webqueryPort: 1 });
    expect(res.status).toBe(201);
    expect(prisma.tsServerConfig.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { name: 'Home', host: 'ts.example.com' },
    }));
  });

  it('refuses a server without a host', async () => {
    const res = await send('POST', '/api/servers', { name: 'Home', host: '  ' });
    expect(res.status).toBe(400);
    expect(prisma.tsServerConfig.create).not.toHaveBeenCalled();
  });

  it('only admins create servers', async () => {
    role = 'viewer';
    const res = await send('POST', '/api/servers', { name: 'Home', host: 'ts.example.com' });
    expect(res.status).toBe(403);
  });

  it('lists only name, host and creation time', async () => {
    prisma.tsServerConfig.findMany.mockResolvedValue([]);
    await send('GET', '/api/servers');
    expect(prisma.tsServerConfig.findMany.mock.calls[0][0].select).toEqual({ id: true, name: true, host: true, createdAt: true });
  });

  it('lists a viewer only the servers granted to them', async () => {
    role = 'viewer';
    prisma.tsServerConfig.findMany.mockResolvedValue([]);
    await send('GET', '/api/servers');
    expect(prisma.tsServerConfig.findMany.mock.calls[0][0].where).toEqual({ userAccess: { some: { userId: 7 } } });
  });
});

describe('PUT /api/servers/:configId', () => {
  it('points the running bots at a new host', async () => {
    prisma.tsServerConfig.findUnique.mockResolvedValue({ id: 3, name: 'Home', host: 'old.example.com' });
    prisma.tsServerConfig.update.mockResolvedValue({ id: 3, name: 'Home', host: 'new.example.com' });
    const res = await send('PUT', '/api/servers/3', { host: 'new.example.com' });
    expect(res.status).toBe(200);
    expect(prisma.tsServerConfig.update.mock.calls[0][0].data).toEqual({ host: 'new.example.com' });
    expect(voiceBotManager.applyServerHost).toHaveBeenCalledWith(3, 'new.example.com');
  });

  it('leaves the bots alone on a rename', async () => {
    prisma.tsServerConfig.findUnique.mockResolvedValue({ id: 3, name: 'Home', host: 'ts.example.com' });
    prisma.tsServerConfig.update.mockResolvedValue({ id: 3, name: 'Away', host: 'ts.example.com' });
    await send('PUT', '/api/servers/3', { name: 'Away', host: 'ts.example.com' });
    expect(voiceBotManager.applyServerHost).not.toHaveBeenCalled();
  });

  it('refuses an empty name', async () => {
    const res = await send('PUT', '/api/servers/3', { name: '' });
    expect(res.status).toBe(400);
    expect(prisma.tsServerConfig.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/servers/:configId', () => {
  it('stops and removes the server\'s bots before deleting it', async () => {
    prisma.musicBot.findMany.mockResolvedValue([{ id: 11 }, { id: 12 }]);
    const order: string[] = [];
    voiceBotManager.removeBot.mockImplementation(async (id: number) => { order.push(`bot ${id}`); });
    prisma.tsServerConfig.delete.mockImplementation(async () => { order.push('server'); });

    const res = await send('DELETE', '/api/servers/3');
    expect(res.status).toBe(204);
    expect(prisma.musicBot.findMany).toHaveBeenCalledWith({ where: { serverConfigId: 3 }, select: { id: true } });
    expect(order).toEqual(['bot 11', 'bot 12', 'server']);
  });
});

describe('requireServerAccess', () => {
  it('answers 404 for a server that does not exist, admin or not', async () => {
    prisma.tsServerConfig.findUnique.mockResolvedValue(null);
    expect((await send('GET', '/api/servers/99/probe')).status).toBe(404);
    role = 'viewer';
    expect((await send('GET', '/api/servers/99/probe')).status).toBe(404);
  });

  it('lets an admin through to any existing server', async () => {
    prisma.tsServerConfig.findUnique.mockResolvedValue({ id: 3 });
    expect((await send('GET', '/api/servers/3/probe')).status).toBe(200);
    expect(prisma.userServerAccess.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a viewer without a grant and admits one with it', async () => {
    role = 'viewer';
    prisma.tsServerConfig.findUnique.mockResolvedValue({ id: 3 });
    prisma.userServerAccess.findUnique.mockResolvedValue(null);
    expect((await send('GET', '/api/servers/3/probe')).status).toBe(403);
    prisma.userServerAccess.findUnique.mockResolvedValue({ userId: 7, serverConfigId: 3 });
    expect((await send('GET', '/api/servers/3/probe')).status).toBe(200);
  });
});
