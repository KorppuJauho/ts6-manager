import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import type { VoiceBotManager } from '../voice/voice-bot-manager.js';

export const serverRoutes: Router = Router();

// A server record is only what a bot needs to find the server: a name for the
// pickers and the host it connects to. The voice port is per bot.
const SERVER_SELECT = { id: true, name: true, host: true, createdAt: true } as const;

function readNameAndHost(body: any, partial: boolean): { name?: string; host?: string } {
  const out: { name?: string; host?: string } = {};
  for (const field of ['name', 'host'] as const) {
    const value = body?.[field];
    if (value === undefined && partial) continue;
    if (typeof value !== 'string' || !value.trim()) {
      throw new AppError(400, partial ? `${field} must not be empty` : 'Name and host are required');
    }
    out[field] = value.trim();
  }
  return out;
}

// List the TeamSpeak servers bots can connect to (viewers: the ones granted to them)
serverRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const servers = await prisma.tsServerConfig.findMany({
      where: req.user?.role === 'admin' ? {} : { userAccess: { some: { userId: req.user!.id } } },
      select: SERVER_SELECT,
      orderBy: { id: 'asc' },
    });
    res.json(servers);
  } catch (err) { next(err); }
});

// Add a server
serverRoutes.post('/', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const { name, host } = readNameAndHost(req.body, false);
    const prisma = req.app.locals.prisma;
    const server = await prisma.tsServerConfig.create({ data: { name, host }, select: SERVER_SELECT });
    res.status(201).json(server);
  } catch (err) { next(err); }
});

// Get one server
serverRoutes.get('/:configId', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const server = await prisma.tsServerConfig.findUnique({
      where: { id: parseInt(String(req.params.configId)) },
      select: SERVER_SELECT,
    });
    if (!server) throw new AppError(404, 'Server config not found');

    if (req.user?.role !== 'admin') {
      const access = await prisma.userServerAccess.findUnique({
        where: { userId_serverConfigId: { userId: req.user!.id, serverConfigId: server.id } },
      });
      if (!access) throw new AppError(403, 'No access to this server');
    }

    res.json(server);
  } catch (err) { next(err); }
});

// Rename a server or point it at another host
serverRoutes.put('/:configId', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(String(req.params.configId));
    const data = readNameAndHost(req.body, true);

    const current = await prisma.tsServerConfig.findUnique({ where: { id } });
    if (!current) throw new AppError(404, 'Server config not found');

    const server = await prisma.tsServerConfig.update({ where: { id }, data, select: SERVER_SELECT });

    // Running bots keep their connection; the new host applies the next time
    // each one connects.
    if (data.host && data.host !== current.host) {
      const manager: VoiceBotManager | undefined = req.app.locals.voiceBotManager;
      manager?.applyServerHost(id, data.host);
    }

    res.json(server);
  } catch (err) { next(err); }
});

// Delete a server, and the bots that connect to it
serverRoutes.delete('/:configId', requireRole('admin'), async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(String(req.params.configId));

    // The cascade deletes the bot rows, but would leave the bots themselves
    // connected; stop and remove them first.
    const manager: VoiceBotManager | undefined = req.app.locals.voiceBotManager;
    const bots = await prisma.musicBot.findMany({ where: { serverConfigId: id }, select: { id: true } });
    for (const bot of bots) await manager?.removeBot(bot.id);

    await prisma.tsServerConfig.delete({ where: { id } });
    res.status(204).send();
  } catch (err) { next(err); }
});
