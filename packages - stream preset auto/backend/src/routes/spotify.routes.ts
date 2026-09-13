import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { encrypt } from '../utils/crypto.js';

export const spotifyRoutes: Router = Router();

spotifyRoutes.use(requireRole('admin'));

async function getOrCreateSettings(prisma: any) {
  const existing = await prisma.spotifySettings.findFirst();
  if (existing) return existing;
  return prisma.spotifySettings.create({ data: {} });
}

// GET /api/spotify/settings — current config (client secret never returned)
spotifyRoutes.get('/settings', async (req: Request, res: Response, next) => {
  try {
    const s = await getOrCreateSettings(req.app.locals.prisma);
    res.json({
      enabled: s.enabled,
      clientId: s.clientId,
      hasClientSecret: !!s.clientSecret,
      maxAlbumTracks: s.maxAlbumTracks,
    });
  } catch (err) { next(err); }
});

// PUT /api/spotify/settings — update config
spotifyRoutes.put('/settings', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await getOrCreateSettings(prisma);
    const { enabled, clientId, clientSecret, maxAlbumTracks } = req.body;

    const data: any = {};
    if (enabled !== undefined) data.enabled = !!enabled;
    if (clientId !== undefined) data.clientId = clientId || null;
    // Empty secret means "unchanged" (same convention as API keys / Discord token)
    if (clientSecret) data.clientSecret = encrypt(String(clientSecret));
    if (maxAlbumTracks !== undefined) data.maxAlbumTracks = Math.max(1, parseInt(maxAlbumTracks) || 50);

    await prisma.spotifySettings.update({ where: { id: current.id }, data });
    res.json({ success: true });
  } catch (err) { next(err); }
});
