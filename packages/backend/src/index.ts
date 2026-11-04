import { createApp } from './app.js';
import { createServer } from 'http';
import { PrismaClient } from '../generated/prisma/index.js';
import { VoiceBotManager } from './voice/voice-bot-manager.js';
import { MusicCommandHandler } from './voice/music-command-handler.js';
import { applyTrustProxy, loadTrustProxy } from './routes/settings.routes.js';
import { config } from './config.js';
import { setYtCookieFile } from './voice/audio/youtube.js';
import { warmUpOpusEncoder } from './voice/audio/pipeline.js';
import { PlaylistImporter } from './voice/playlist-import.js';
import fs from 'fs';
import path from 'path';

// Last-resort safety net: a single bot/track glitch, an unawaited promise, or a
// late event must never take the whole backend (serving every user) down. Log
// the full error — including the stack, so the real cause is captured next time
// — and keep running. The audio path additionally guards itself (failPlayback),
// so this is defence in depth, not the primary handler.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception (kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection (kept alive):', reason);
});

async function main() {
  // config.ts already requires both secrets to be present and long enough,
  // in every environment. What is left to check is that they are not the same
  // value, so a leaked signing key cannot also decrypt stored credentials.
  if (config.encryptionKey === config.jwtSecret) {
    console.error('[FATAL] ENCRYPTION_KEY must be different from JWT_SECRET.');
    process.exit(1);
  }

  // Configure yt-dlp cookie file: env var takes priority, then saved file from data dir
  const cookiePath = process.env.YT_COOKIE_FILE;
  const savedCookiePath = path.resolve('data', 'yt-cookies.txt');
  if (cookiePath && fs.existsSync(cookiePath)) {
    setYtCookieFile(cookiePath);
    console.log(`[yt-dlp] Using cookie file (env): ${cookiePath}`);
  } else if (fs.existsSync(savedCookiePath)) {
    setYtCookieFile(savedCookiePath);
    console.log(`[yt-dlp] Using saved cookie file: ${savedCookiePath}`);
  } else if (cookiePath) {
    console.warn(`[yt-dlp] Cookie file not found: ${cookiePath}`);
  }

  const prisma = new PrismaClient();
  const app = createApp();
  const server = createServer(app);

  // Apply the WebUI-configured reverse-proxy hop count (real client IP from XFF)
  applyTrustProxy(app, await loadTrustProxy(prisma));

  // YouTube/batch downloads run inside the HTTP request; Node's default
  // 5-minute request timeout kills long playlist imports mid-flight while the
  // download loop keeps running server-side (the UI shows an error but songs
  // keep appearing). headersTimeout keeps its default, so slowloris
  // protection is unaffected.
  server.requestTimeout = 0;

  // Make services available via app.locals
  app.locals.prisma = prisma;

  // Initialize Voice Bot Manager (Music Bots). Warm the Opus encoder first, so
  // the first song after a restart does not pay for compiling it.
  warmUpOpusEncoder();
  const voiceBotManager = new VoiceBotManager(prisma);
  app.locals.voiceBotManager = voiceBotManager;
  await voiceBotManager.start();

  const playlistImporter = new PlaylistImporter(prisma);
  app.locals.playlistImporter = playlistImporter;

  // Wire Music Command Handler for text-based music bot control (!radio, !play, etc.)
  // Listens directly on each VoiceBot's own TS3 connection
  const musicCommandHandler = new MusicCommandHandler(prisma);
  musicCommandHandler.setPlaylistImporter(playlistImporter);
  voiceBotManager.setMusicCommandHandler(musicCommandHandler);

  server.listen(config.port, () => {
    console.log(`[TS6 WebUI] Backend running on http://localhost:${config.port}`);
    console.log(`[TS6 WebUI] Environment: ${config.nodeEnv}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[TS6 WebUI] Shutting down...');
    await voiceBotManager.stopAll();
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
