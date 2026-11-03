import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import type { VoiceBotManager } from '../voice/voice-bot-manager.js';
import { config } from '../config.js';

// Public, unauthenticated: embedded in TeamSpeak channel descriptions and web
// pages. Access is by the per-bot HMAC token below.
export const playerWidgetRoutes: Router = Router();

/** Generate a deterministic token for a bot ID using HMAC */
function playerWidgetToken(botId: number): string {
  return crypto.createHmac('sha256', config.jwtSecret).update(`player-widget:${botId}`).digest('hex').slice(0, 16);
}

/** Exported so admin routes can generate tokens for the UI */
export { playerWidgetToken };

// GET /player/:botId/data?token=xxx — JSON: now playing + upcoming queue
playerWidgetRoutes.get('/player/:botId/data', async (req: Request, res: Response, next) => {
  try {
    const botId = parseInt(String(req.params.botId));
    const token = req.query.token as string;
    if (!token || token !== playerWidgetToken(botId)) {
      return res.status(403).json({ error: 'Invalid token' });
    }

    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(botId);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const nowPlaying = bot.nowPlaying;
    const progress = bot.playbackProgress;
    const queueItems = bot.queue.getAll();
    const upcoming = queueItems.slice(0, 5);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=10');
    res.json({
      nowPlaying: nowPlaying ? { title: nowPlaying.title, artist: nowPlaying.artist, duration: nowPlaying.duration, source: nowPlaying.source } : null,
      progress: progress ? { position: progress.position, duration: progress.duration } : null,
      status: bot.status,
      queueLength: queueItems.length,
      upcoming: upcoming.map((q) => ({ title: q.title, artist: q.artist, duration: q.duration })),
    });
  } catch (err) { next(err); }
});

// GET /player/:botId/bbcode?token=xxx — BBCode for TS channel description
playerWidgetRoutes.get('/player/:botId/bbcode', async (req: Request, res: Response, next) => {
  try {
    const botId = parseInt(String(req.params.botId));
    const token = req.query.token as string;
    if (!token || token !== playerWidgetToken(botId)) {
      return res.status(403).json({ error: 'Invalid token' });
    }

    const manager: VoiceBotManager = req.app.locals.voiceBotManager;
    const bot = manager.getBot(botId);
    if (!bot) return res.status(404).send('Bot not found');

    const nowPlaying = bot.nowPlaying;
    const progress = bot.playbackProgress;
    const queueItems = bot.queue.getAll();
    const upcoming = queueItems.slice(0, 5);

    let bb = '[b]🎵 Now Playing[/b]\n';
    if (nowPlaying) {
      const artist = nowPlaying.artist ? ` — ${nowPlaying.artist}` : '';
      bb += `[color=#00aaff]${nowPlaying.title}${artist}[/color]\n`;
      if (progress) {
        const pos = formatTime(progress.position);
        const dur = formatTime(progress.duration);
        bb += `${pos} / ${dur}\n`;
      }
    } else {
      bb += '[i]Nothing playing[/i]\n';
    }

    if (upcoming.length > 0) {
      bb += '\n[b]Up Next[/b]\n';
      upcoming.forEach((item, i) => {
        const artist = item.artist ? ` — ${item.artist}` : '';
        bb += `${i + 1}. ${item.title}${artist}\n`;
      });
      if (queueItems.length > 5) {
        bb += `[i]... and ${queueItems.length - 5} more[/i]\n`;
      }
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=10');
    res.send(bb);
  } catch (err) { next(err); }
});

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
