import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';

export const musicCommandSettingsRoutes: Router = Router();

musicCommandSettingsRoutes.use(requireRole('admin'));

async function getOrCreate(prisma: any) {
  const existing = await prisma.musicCommandSettings.findFirst();
  if (existing) return existing;
  return prisma.musicCommandSettings.create({ data: {} });
}

/** Normalise an incoming sgid value: '', null, 0 -> null; else a positive int. */
function normSgid(v: any): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// GET /api/music-command-settings
musicCommandSettingsRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const s = await getOrCreate(req.app.locals.prisma);
    res.json({
      musicCommandSgid: s.musicCommandSgid,
      adminCommandSgid: s.adminCommandSgid,
      notifyNowPlaying: s.notifyNowPlaying,
    });
  } catch (err) { next(err); }
});

// PUT /api/music-command-settings
musicCommandSettingsRoutes.put('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await getOrCreate(prisma);
    const { musicCommandSgid, adminCommandSgid, notifyNowPlaying } = req.body;

    const data: any = {};
    if (musicCommandSgid !== undefined) data.musicCommandSgid = normSgid(musicCommandSgid);
    if (adminCommandSgid !== undefined) data.adminCommandSgid = normSgid(adminCommandSgid);
    if (notifyNowPlaying !== undefined) data.notifyNowPlaying = !!notifyNowPlaying;

    await prisma.musicCommandSettings.update({ where: { id: current.id }, data });
    res.json({ success: true });
  } catch (err) { next(err); }
});
