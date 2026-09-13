import { createApp } from './app.js';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { PrismaClient } from '../generated/prisma/index.js';
import { ConnectionPool } from './ts-client/connection-pool.js';
import { BotEngine } from './bot-engine/engine.js';
import { VoiceBotManager } from './voice/voice-bot-manager.js';
import { MusicCommandHandler } from './voice/music-command-handler.js';
import { DiscordBridge } from './discord/discord-bridge.js';
import { ConnectionJournal } from './connection-journal.js';
import { applyTrustProxy, loadTrustProxy } from './routes/settings.routes.js';
import { loadSamlRuntime } from './auth/saml/saml-config.js';
import { config } from './config.js';
import { setYtCookieFile } from './voice/audio/youtube.js';
import jwt from 'jsonwebtoken';
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
  // C1: JWT secret startup guard
  if (config.jwtSecret === 'dev-secret-change-me-in-production') {
    if (config.nodeEnv === 'production') {
      console.error('[FATAL] JWT_SECRET is set to the default value. Set a secure JWT_SECRET environment variable before running in production.');
      process.exit(1);
    }
    console.warn('[WARN] JWT_SECRET is using the default development value. Set JWT_SECRET in production!');
  }

  // ENCRYPTION_KEY startup guard: stored credentials (SSH passwords, API keys)
  // must not be decryptable from a leaked JWT_SECRET alone.
  if (config.nodeEnv === 'production') {
    if (!process.env.ENCRYPTION_KEY) {
      console.error('[FATAL] ENCRYPTION_KEY is not set. Set a dedicated ENCRYPTION_KEY (distinct from JWT_SECRET) before running in production.');
      process.exit(1);
    }
    if (process.env.ENCRYPTION_KEY === config.jwtSecret) {
      console.error('[FATAL] ENCRYPTION_KEY must be different from JWT_SECRET.');
      process.exit(1);
    }
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

  // H3: WebSocket with JWT authentication
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ req }, done) => {
      try {
        const wsUrl = new URL(req.url!, `http://${req.headers.host}`);
        const token = wsUrl.searchParams.get('token');
        if (!token) return done(false, 401, 'Missing token');
        jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
        done(true);
      } catch {
        done(false, 401, 'Invalid token');
      }
    },
  });

  // Initialize TS connection pool
  const connectionPool = new ConnectionPool(prisma);
  await connectionPool.initialize();

  // Make services available via app.locals
  app.locals.prisma = prisma;
  app.locals.connectionPool = connectionPool;
  app.locals.wss = wss;

  // Load the SAML SP config/instance from the DB (no-op if SAML is unconfigured/disabled)
  await loadSamlRuntime(prisma);

  // Initialize Bot Engine
  const botEngine = new BotEngine(prisma, connectionPool, wss, app);
  app.locals.botEngine = botEngine;
  await botEngine.start();

  // Initialize Voice Bot Manager (Music Bots)
  const voiceBotManager = new VoiceBotManager(prisma, wss);
  app.locals.voiceBotManager = voiceBotManager;
  await voiceBotManager.start();

  // Wire VoiceBotManager into BotEngine for voice action nodes in flows
  botEngine.setVoiceBotManager(voiceBotManager);

  // Wire Music Command Handler for text-based music bot control (!radio, !play, etc.)
  // Listens directly on each VoiceBot's TS3 connection (no SSH needed)
  const musicCommandHandler = new MusicCommandHandler(prisma, voiceBotManager, connectionPool);
  voiceBotManager.setMusicCommandHandler(musicCommandHandler);

  // Discord bridge: slash commands, TS notifications, stats (non-blocking)
  const discordBridge = new DiscordBridge(prisma, connectionPool, voiceBotManager);
  app.locals.discordBridge = discordBridge;
  discordBridge.start().catch((err) => {
    console.error(`[Discord] Failed to start: ${err.message}`);
  });

  // Wire Discord ↔ bot flows: Discord message triggers + send-message action
  botEngine.setDiscordBridge(discordBridge);
  discordBridge.setMessageHandler((msg) => botEngine.handleDiscordMessage(msg));

  // Connection journal: web + TS connection logging (non-blocking)
  const connectionJournal = new ConnectionJournal(prisma, connectionPool, voiceBotManager);
  app.locals.connectionJournal = connectionJournal;
  connectionJournal.start().catch((err) => {
    console.error(`[Journal] Failed to start: ${err.message}`);
  });

  server.listen(config.port, () => {
    console.log(`[TS6 WebUI] Backend running on http://localhost:${config.port}`);
    console.log(`[TS6 WebUI] WebSocket available at ws://localhost:${config.port}/ws`);
    console.log(`[TS6 WebUI] Environment: ${config.nodeEnv}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[TS6 WebUI] Shutting down...');
    await discordBridge.stop();
    await connectionJournal.stop();
    await voiceBotManager.stopAll();
    botEngine.destroy();
    connectionPool.destroy();
    wss.close();
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
