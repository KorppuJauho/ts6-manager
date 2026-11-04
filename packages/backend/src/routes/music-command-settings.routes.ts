import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';

export const musicCommandSettingsRoutes: Router = Router();

musicCommandSettingsRoutes.use(requireRole('admin'));

async function getOrCreate(prisma: any) {
  const existing = await prisma.musicCommandSettings.findFirst();
  if (existing) return existing;
  return prisma.musicCommandSettings.create({ data: {} });
}

// GET /api/music-command-settings
musicCommandSettingsRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const s = await getOrCreate(req.app.locals.prisma);
    res.json({
      notifyNowPlaying: s.notifyNowPlaying,
    });
  } catch (err) { next(err); }
});

// PUT /api/music-command-settings
musicCommandSettingsRoutes.put('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await getOrCreate(prisma);
    const { notifyNowPlaying } = req.body;

    const data: any = {};
    if (notifyNowPlaying !== undefined) data.notifyNowPlaying = !!notifyNowPlaying;

    await prisma.musicCommandSettings.update({ where: { id: current.id }, data });
    res.json({ success: true });
  } catch (err) { next(err); }
});
