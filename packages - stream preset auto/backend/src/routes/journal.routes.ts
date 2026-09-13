import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { RETENTION_KEY, DEFAULT_RETENTION_DAYS } from '../connection-journal.js';
import { buildJournalQuery } from './journal-query.js';
import { durationToExpiry } from '../utils/web-ban.js';
import { normalizeIp } from '../utils/geo.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';

export const journalRoutes: Router = Router();

journalRoutes.use(requireRole('admin'));

// GET /api/journal/retention — current retention (days)
journalRoutes.get('/retention', async (req: Request, res: Response, next) => {
  try {
    const row = await req.app.locals.prisma.appSetting.findUnique({ where: { key: RETENTION_KEY } });
    res.json({ retentionDays: row ? parseInt(row.value) : DEFAULT_RETENTION_DAYS });
  } catch (err) { next(err); }
});

// PUT /api/journal/retention — set retention (days, 0 = keep all)
journalRoutes.put('/retention', async (req: Request, res: Response, next) => {
  try {
    const days = parseInt(req.body.retentionDays);
    if (isNaN(days) || days < 0 || days > 3650) throw new AppError(400, 'retentionDays must be between 0 and 3650');
    await req.app.locals.prisma.appSetting.upsert({
      where: { key: RETENTION_KEY },
      update: { value: String(days) },
      create: { key: RETENTION_KEY, value: String(days) },
    });
    res.json({ retentionDays: days });
  } catch (err) { next(err); }
});

// GET /api/journal — paginated connection log
journalRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const page = Math.max(1, parseInt(String(req.query.page)) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit)) || 50));

    const { where, orderBy } = buildJournalQuery({
      source: String(req.query.source || ''),
      hideBots: String(req.query.hideBots || ''),
      login: req.query.login ? String(req.query.login) : undefined,
      ip: req.query.ip ? String(req.query.ip) : undefined,
      country: req.query.country ? String(req.query.country) : undefined,
      result: req.query.result ? String(req.query.result) : undefined,
      sort: req.query.sort ? String(req.query.sort) : undefined,
      dir: req.query.dir ? String(req.query.dir) : undefined,
    });

    const [total, entries] = await Promise.all([
      prisma.connectionLog.count({ where }),
      prisma.connectionLog.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
    ]);

    res.json({ entries, total, page, limit });
  } catch (err) { next(err); }
});

// POST /api/journal/ban — block an IP on the web and/or TeamSpeak
journalRoutes.post('/ban', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const ip = normalizeIp(String(req.body.ip || '').trim());
    const targets: string[] = Array.isArray(req.body.targets) ? req.body.targets : [];
    const reason = req.body.reason ? String(req.body.reason) : undefined;
    const durationMinutes = parseInt(req.body.durationMinutes) || 0;
    if (!ip) throw new AppError(400, 'ip is required');
    if (targets.length === 0) throw new AppError(400, 'select at least one target');

    const result: any = {};

    if (targets.includes('web')) {
      const expiresAt = durationToExpiry(durationMinutes);
      await prisma.webBan.upsert({
        where: { ip },
        update: { reason: reason ?? null, expiresAt },
        create: { ip, reason: reason ?? null, expiresAt },
      });
      result.web = { ok: true, expiresAt };
    }

    if (targets.includes('teamspeak')) {
      const pool: ConnectionPool = req.app.locals.connectionPool;
      const servers = await prisma.tsServerConfig.findMany({ where: { enabled: true } });
      const time = durationMinutes > 0 ? durationMinutes * 60 : 0;
      const perServer: Array<{ server: string; ok: boolean; error?: string }> = [];
      for (const s of servers) {
        try {
          const client = await pool.getOrLoad(s.id);
          await client.execute(1, 'banadd', { ip, time, banreason: reason });
          perServer.push({ server: s.name, ok: true });
        } catch (err: any) {
          perServer.push({ server: s.name, ok: false, error: err.message });
        }
      }
      result.teamspeak = { perServer };
    }

    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/journal/web-bans — active web bans
journalRoutes.get('/web-bans', async (req: Request, res: Response, next) => {
  try {
    const bans = await req.app.locals.prisma.webBan.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(bans);
  } catch (err) { next(err); }
});

// DELETE /api/journal/web-bans/:id — revoke a web ban
journalRoutes.delete('/web-bans/:id', async (req: Request, res: Response, next) => {
  try {
    await req.app.locals.prisma.webBan.delete({ where: { id: parseInt(String(req.params.id)) } });
    res.status(204).send();
  } catch (err) { next(err); }
});
