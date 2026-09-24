import { spawn } from 'child_process';
import { SOURCE_SEPARATOR } from './types.js';

/**
 * FFprobe only ever needs to read the network protocols a stream source uses.
 * Without this an HLS playlist can point at `file:` or `concat:` and have
 * ffprobe open it — the same class of hole the sidecar's per-segment source
 * validation closes on the encode side.
 */
const PROTOCOL_WHITELIST = 'http,https,tcp,tls,crypto';

/**
 * A live source answers in well under a second; a dead one never answers at
 * all. This bounds how long a stream start can be delayed by the probe,
 * because failing to probe is not a reason to refuse to stream.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 6_000;

/**
 * Read the height of the first video stream out of `ffprobe -of json` output.
 *
 * Separate from the spawn so the parsing is testable without ffprobe present.
 */
export function parseProbedHeight(stdout: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  const streams = (parsed as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) return null;

  for (const stream of streams) {
    const height = (stream as { height?: unknown }).height;
    // Audio streams have no height, and ffprobe reports 0 for a video stream
    // whose dimensions it could not determine.
    if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
      return Math.round(height);
    }
  }
  return null;
}

/**
 * Measure the native height of a video source, or null if it cannot be
 * determined.
 *
 * Null is an ordinary outcome, not an error: a source that refuses to be
 * probed still streams fine, it just does not get its quality preset adjusted.
 * Every failure path — ffprobe missing, timeout, non-zero exit, unparseable
 * output — collapses to null for that reason.
 */
export async function probeVideoHeight(
  source: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<number | null> {

  // A DASH pair carries video first; probing the audio URL would find no
  // video stream and report nothing.
  const url = source.split(SOURCE_SEPARATOR)[0]?.trim() ?? '';

  // ffprobe resolves an input by protocol, so anything that is not plainly
  // http(s) is refused rather than handed over. The whitelist below is the
  // second layer; this is the one that keeps a `file:` path from reaching it.
  if (!/^https?:\/\//i.test(url)) return null;

  return new Promise((resolve) => {
    const proc = spawn(
      'ffprobe',
      [
        '-v', 'error',
        '-protocol_whitelist', PROTOCOL_WHITELIST,
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'json',
        // -i takes the URL as an option argument, so a source starting with
        // "-" cannot be read as a flag.
        '-i', url,
      ],
      { shell: false },
    );

    let stdout = '';
    let settled = false;
    const finish = (height: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(height);
    };

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      console.warn(`[Probe] ffprobe timed out after ${timeoutMs / 1000}s`);
      finish(null);
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.resume();

    proc.on('error', (err) => {
      console.warn(`[Probe] ffprobe unavailable: ${err.message}`);
      finish(null);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      finish(parseProbedHeight(stdout));
    });
  });
}
