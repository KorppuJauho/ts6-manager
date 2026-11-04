/**
 * Serves yt-dlp sources to the sidecar through yt-dlp itself.
 *
 * YouTube refuses the media URLs `yt-dlp -g` prints when anything other than
 * yt-dlp fetches them: 403 for the sidecar's FFmpeg, with or without yt-dlp's
 * own request headers and byte ranges (seen 2026-11 with yt-dlp 2026.10.26).
 * `yt-dlp -o -` still streams the very same format. So the sidecar is not
 * given the media URLs any more but URLs of this relay, one per format of the
 * chosen pair, and each fetch runs `yt-dlp -f <format> -o - -- <page>` and
 * pipes its output through. Whatever YouTube changes next is yt-dlp's to keep
 * up with, and the image refreshes yt-dlp on every start.
 *
 * The relay is outside /api: the frontend's nginx does not proxy it, and it
 * takes no session. Access is by an unguessable token per source, revoked
 * when the stream stops or changes source, and expiring on its own after
 * RELAY_TTL_MS in case a stop is missed. The backend port may be published on
 * the host, so the token is the whole protection: it never leaves the
 * backend-to-sidecar request.
 */
import { Router, type Request, type Response } from 'express';
import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import { config } from '../../config.js';
import { getCookieArgs } from '../audio/youtube.js';
import { SOURCE_SEPARATOR } from './types.js';

/** Longer than any stream is expected to run; a stop revokes it far sooner. */
export const RELAY_TTL_MS = 24 * 60 * 60 * 1000;

interface RelayEntry {
  pageUrl: string;
  formatIds: string[];
  expiresAt: number;
}

const relays = new Map<string, RelayEntry>();

function sweep(now: number): void {
  for (const [token, entry] of relays) {
    if (entry.expiresAt <= now) relays.delete(token);
  }
}

/**
 * Where the sidecar reaches the backend. In Docker the sidecar is its own
 * container and resolves the compose service name; spawned locally it shares
 * the host. BACKEND_INTERNAL_URL overrides both, for a deployment that names
 * the service differently.
 */
export function relayBaseUrl(): string {
  const override = process.env.BACKEND_INTERNAL_URL?.trim();
  if (override) return override.replace(/\/+$/, '');
  return process.env.SIDECAR_URL ? `http://backend:${config.port}` : `http://127.0.0.1:${config.port}`;
}

/**
 * Register a source and return what the sidecar plays: one relay URL per
 * format (video, then audio, for a DASH pair), joined by SOURCE_SEPARATOR,
 * and a function that revokes them.
 */
export function registerRelay(pageUrl: string, formatIds: string[], now: number = Date.now()): { source: string; release: () => void } {
  if (formatIds.length === 0) throw new Error('yt-dlp chose no format');
  sweep(now);
  const token = crypto.randomBytes(24).toString('base64url');
  relays.set(token, { pageUrl, formatIds, expiresAt: now + RELAY_TTL_MS });
  const base = relayBaseUrl();
  const source = formatIds.map((_, i) => `${base}/internal/relay/${token}/${i}`).join(SOURCE_SEPARATOR);
  return { source, release: () => { relays.delete(token); } };
}

/** The format a relay URL serves, or null for an unknown, expired or revoked one. */
export function lookupRelay(token: string, index: number, now: number = Date.now()): { pageUrl: string; formatId: string } | null {
  const entry = relays.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    relays.delete(token);
    return null;
  }
  const formatId = entry.formatIds[index];
  return formatId ? { pageUrl: entry.pageUrl, formatId } : null;
}

type Spawn = (command: string, args: string[]) => ChildProcess;

/** The yt-dlp arguments that write one format of a page to stdout. */
export function relayArgs(pageUrl: string, formatId: string): string[] {
  return [
    ...getCookieArgs(),
    '-q', '--no-warnings',
    '--no-playlist',
    '-f', formatId,
    '-o', '-',
    '--',  // nothing past this point is parsed as an option
    pageUrl,
  ];
}

export function createRelayRoutes(spawnFn: Spawn = (cmd, args) => spawn(cmd, args, { shell: false })): Router {
  const routes = Router();

  routes.get('/:token/:index', (req: Request, res: Response) => {
    const index = Number(req.params.index);
    const found = Number.isInteger(index) ? lookupRelay(String(req.params.token), index) : null;
    if (!found) {
      res.status(404).end();
      return;
    }

    const proc = spawnFn('yt-dlp', relayArgs(found.pageUrl, found.formatId));
    let stderr = '';
    let closedByClient = false;
    proc.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });

    res.status(200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    proc.stdout?.pipe(res);

    // The sidecar closes the connection when FFmpeg stops (stream stopped,
    // source changed, restarted); yt-dlp must not keep downloading for nobody.
    res.on('close', () => {
      if (proc.exitCode === null && proc.signalCode === null) {
        closedByClient = true;
        proc.kill('SIGKILL');
      }
    });

    proc.on('error', (err) => {
      console.error(`[Relay] yt-dlp could not start: ${err.message}`);
      res.destroy();
    });
    proc.on('close', (code) => {
      if (code !== 0 && !closedByClient) {
        console.error(`[Relay] yt-dlp failed (code ${code}) for format ${found.formatId}: ${stderr.trim().split('\n').pop() ?? ''}`);
        // Headers are already sent; ending the body early is the only signal
        // FFmpeg gets, and it reports the input as truncated.
        res.destroy();
      }
    });
  });

  return routes;
}

/**
 * Parse `--print "%(vcodec)s %(format_id)s %(height)s"`: the chosen video
 * codec, the format ids ("398+251" for a DASH pair, "18" for progressive),
 * and the video height, which yt-dlp knows without fetching anything.
 */
export function parseRelayFormat(stdout: string): { vcodec: string; formatIds: string[]; height: number | null } {
  const line = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const [vcodec = '', formatId = '', heightText = ''] = line.split(/\s+/);
  const height = Number(heightText);
  return {
    vcodec,
    formatIds: formatId.split('+').filter(Boolean),
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
  };
}
