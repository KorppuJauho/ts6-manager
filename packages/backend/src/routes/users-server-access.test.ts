import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { errorHandler } from '../middleware/error-handler.js';
import { userRoutes } from './users.routes.js';

const prisma = {
  user: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
  userServerAccess: { deleteMany: vi.fn(), createMany: vi.fn() },
  tsServerConfig: { count: vi.fn() },
  appSetting: { findUnique: vi.fn() },
  $transaction: vi.fn(),
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.locals.prisma = prisma;
  app.use((req, _res, next) => {
    (req as any).user = { id: 1, role: 'admin' };
    next();
  });
  app.use('/api/users', userRoutes);
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  vi.resetAllMocks();
  prisma.$transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
  prisma.appSetting.findUnique.mockResolvedValue(null);
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

describe('viewer server access', () => {
  it('lists each user with the ids of the servers granted to them', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 2, username: 'v', role: 'viewer', serverAccess: [{ serverConfigId: 3 }, { serverConfigId: 5 }] },
    ]);
    const res = await send('GET', '/api/users');
    const [user] = await res.json();
    expect(user.serverIds).toEqual([3, 5]);
    expect(user.serverAccess).toBeUndefined();
  });

  it('replaces a user\'s grants in the same transaction as the update', async () => {
    prisma.tsServerConfig.count.mockResolvedValue(2);
    const res = await send('PUT', '/api/users/2', { serverIds: [3, 5, 3] });
    expect(res.status).toBe(204);
    expect(prisma.userServerAccess.deleteMany).toHaveBeenCalledWith({ where: { userId: 2 } });
    expect(prisma.userServerAccess.createMany).toHaveBeenCalledWith({
      data: [{ userId: 2, serverConfigId: 3 }, { userId: 2, serverConfigId: 5 }],
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('clears every grant for an empty list', async () => {
    const res = await send('PUT', '/api/users/2', { serverIds: [] });
    expect(res.status).toBe(204);
    expect(prisma.userServerAccess.deleteMany).toHaveBeenCalledWith({ where: { userId: 2 } });
    expect(prisma.userServerAccess.createMany).not.toHaveBeenCalled();
  });

  it('leaves grants alone when the update does not mention them', async () => {
    const res = await send('PUT', '/api/users/2', { displayName: 'Vee' });
    expect(res.status).toBe(204);
    expect(prisma.userServerAccess.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a server that does not exist, changing nothing', async () => {
    prisma.tsServerConfig.count.mockResolvedValue(1);
    const res = await send('PUT', '/api/users/2', { serverIds: [3, 99] });
    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.userServerAccess.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses ids that are not server ids', async () => {
    for (const serverIds of ['3', [0], [1.5], ['x']]) {
      const res = await send('PUT', '/api/users/2', { serverIds });
      expect(res.status, JSON.stringify(serverIds)).toBe(400);
    }
  });

  it('creates a viewer with its grants', async () => {
    prisma.tsServerConfig.count.mockResolvedValue(1);
    prisma.user.create.mockResolvedValue({ id: 4, username: 'new' });
    const res = await send('POST', '/api/users', {
      username: 'new', password: 'Long-enough-Passw0rd!', displayName: 'New', role: 'viewer', serverIds: [3],
    });
    expect(res.status).toBe(201);
    expect(prisma.user.create.mock.calls[0][0].data.serverAccess).toEqual({ create: [{ serverConfigId: 3 }] });
  });
});
