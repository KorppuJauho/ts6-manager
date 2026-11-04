import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { isBotLanguage, BOT_LANGUAGES, DEFAULT_BOT_LANGUAGE } from '../voice/bot-i18n/index.js';

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
      language: s.language ?? DEFAULT_BOT_LANGUAGE,
      availableLanguages: BOT_LANGUAGES,
    });
  } catch (err) { next(err); }
});

// PUT /api/music-command-settings
musicCommandSettingsRoutes.put('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await getOrCreate(prisma);
    const { notifyNowPlaying, language } = req.body;

    const data: any = {};
    if (notifyNowPlaying !== undefined) data.notifyNowPlaying = !!notifyNowPlaying;
    if (language !== undefined) {
      if (!isBotLanguage(language)) {
        return res.status(400).json({ error: `Unsupported language "${language}"` });
      }
      data.language = language;
    }

    await prisma.musicCommandSettings.update({ where: { id: current.id }, data });
    res.json({ success: true });
  } catch (err) { next(err); }
});
