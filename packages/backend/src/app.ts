import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { errorHandler } from './middleware/error-handler.js';
import { authMiddleware } from './middleware/auth.js';
import { authRoutes } from './routes/auth.routes.js';
import { serverRoutes } from './routes/servers.routes.js';
import { userRoutes } from './routes/users.routes.js';
import { musicBotRoutes } from './routes/music-bots.routes.js';
import { musicLibraryRoutes } from './routes/music-library.routes.js';
import { playlistRoutes } from './routes/playlists.routes.js';
import { radioStationRoutes } from './routes/radio-stations.routes.js';
import { musicRequestRoutes } from './routes/music-requests.routes.js';
import { setupRoutes } from './routes/setup.routes.js';
import { settingsRoutes } from './routes/settings.routes.js';
import { spotifyRoutes } from './routes/spotify.routes.js';
import { musicCommandSettingsRoutes } from './routes/music-command-settings.routes.js';
import { streamSettingsRoutes } from './routes/stream-settings.routes.js';
import { requireServerAccess } from './middleware/server-access.js';
import { createRelayRoutes } from './voice/streaming/yt-relay.js';
import { requireIntParams } from './middleware/validate-params.js';

export function createApp(): Express {
  const app = express();

  // Trust the reverse-proxy chain so req.ip reflects the real client from
  // X-Forwarded-For. Default 1 (the bundled frontend nginx); index.ts overrides
  // this at startup from the DB-backed, WebUI-configurable hop count.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: config.frontendUrl, credentials: true }));
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // H1: Rate limiting on auth endpoints
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, please try again later' },
  });
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/refresh', authLimiter);

  // Global API rate limit (auth endpoints above keep their stricter limit)
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down' },
  });
  app.use('/api', apiLimiter);

  // Public routes
  app.use('/api/setup', setupRoutes);
  app.use('/api/auth', authRoutes);

  // yt-dlp sources for the sidecar, outside /api: token per source, no
  // session (see voice/streaming/yt-relay.ts)
  app.use('/internal/relay', createRelayRoutes());

  // Protected routes
  app.use('/api', authMiddleware);
  app.use('/api/servers', serverRoutes);

  // H9: Server access control on all :configId routes
  // (NaN guard first: parseInt would otherwise forward NaN to Prisma)
  const serverAccess = [requireIntParams('configId'), requireServerAccess()];
  app.use('/api/users', userRoutes);
  app.use('/api/music-bots', musicBotRoutes);
  app.use('/api/servers/:configId/music-library', serverAccess, musicLibraryRoutes);
  app.use('/api/playlists', playlistRoutes);
  app.use('/api/servers/:configId/radio-stations', serverAccess, radioStationRoutes);
  app.use('/api/servers/:configId/music-requests', serverAccess, musicRequestRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/spotify', spotifyRoutes);
  app.use('/api/music-command-settings', musicCommandSettingsRoutes);
  app.use('/api/stream-settings', streamSettingsRoutes);

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}
