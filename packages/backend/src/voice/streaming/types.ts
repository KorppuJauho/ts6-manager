/**
 * Video streaming types and quality presets
 */

export interface VideoStreamPreset {
  label: string;
  width: number;
  height: number;
  bitrate: string;
  framerate: number;
}

/**
 * TeamSpeak caps a video stream at 10 Mbit/s. Presets stay under it with
 * headroom, because the encoder overshoots its target on complex scenes and a
 * stream that trips the ceiling is dropped, not throttled.
 */
export const MAX_STREAM_BITRATE_KBPS = 10000;

export const STREAM_PRESETS: Record<string, VideoStreamPreset> = {
  '480p': { label: '480p', width: 854, height: 480, bitrate: '1000k', framerate: 24 },
  '720p': { label: '720p', width: 1280, height: 720, bitrate: '2500k', framerate: 30 },
  '1080p': { label: '1080p', width: 1920, height: 1080, bitrate: '5500k', framerate: 30 },
  '1440p': { label: '1440p', width: 2560, height: 1440, bitrate: '9000k', framerate: 30 },
  // 9500k, not the ~18000k this resolution would otherwise want: the
  // TeamSpeak ceiling binds here, so 4K trades quality for fitting under it.
  '2160p': { label: '2160p (4K)', width: 3840, height: 2160, bitrate: '9500k', framerate: 30 },
};

export const DEFAULT_PRESET = '1080p';

/**
 * Joins the video and audio URLs of a DASH source into the single `source`
 * string the sidecar's HTTP API carries. The sidecar splits on it and gives
 * FFmpeg one `-i` per segment; it must stay in sync with `sourceSeparator`
 * in packages/sidecar/main.go.
 */
export const SOURCE_SEPARATOR = '|||';

export interface VideoViewerInfo {
  clid: number;
  joinedAt: number;
  iceState: string;
}

export interface VideoStreamStatus {
  streaming: boolean;
  streamId: string | null;
  source: string | null;
  preset: string;
  framerate: number;
  bitrate: string;
  startedAt: number | null;
  viewerCount: number;
  viewers: VideoViewerInfo[];
  sidecar: { videoPort: number; audioPort: number } | null;
}

/**
 * Hold a bitrate under the TeamSpeak ceiling.
 *
 * Accepts FFmpeg's spelling ("4500k", "2M") and returns the same shape.
 * An unparseable value is returned untouched — the sidecar validates the
 * format separately, and silently rewriting something we do not understand
 * would be worse than passing it through.
 */
export function clampBitrate(bitrate: string): string {
  const match = /^(\d+)([kKmM]?)$/.exec(bitrate.trim());
  if (!match) return bitrate;

  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const kbps = unit === 'm' ? value * 1000 : unit === 'k' ? value : value / 1000;
  if (kbps <= MAX_STREAM_BITRATE_KBPS) return bitrate;

  return `${MAX_STREAM_BITRATE_KBPS}k`;
}

/**
 * Pick the preset to actually encode at, given the one that was asked for and
 * the source's own height.
 *
 * Encoding a 720p channel at the 1080p preset upscales it: the picture gains
 * no detail, the encoder spends 5500k carrying interpolated pixels, and the
 * viewer sees a softer image than the source. So the result is capped at the
 * source's height.
 *
 * It only ever goes down. The requested preset is a ceiling the operator set,
 * and a 4K source must not pull a deliberate 720p stream up to 2160p.
 *
 * An unknown height (probe failed) or an unknown preset leaves the request
 * alone — guessing would be worse than streaming at the configured quality.
 */
export function presetForHeight(requested: string, sourceHeight: number | null): string {
  const requestedPreset = STREAM_PRESETS[requested];
  if (!requestedPreset) return requested;
  if (sourceHeight === null || !Number.isFinite(sourceHeight) || sourceHeight <= 0) {
    return requested;
  }
  if (sourceHeight >= requestedPreset.height) return requested;

  const candidates = Object.entries(STREAM_PRESETS)
    .filter(([, preset]) => preset.height <= requestedPreset.height)
    .sort((a, b) => a[1].height - b[1].height);

  // Largest preset the source can fill; if the source is smaller than every
  // preset, the smallest one is the closest available fit.
  let chosen = candidates[0]?.[0] ?? requested;
  for (const [key, preset] of candidates) {
    if (preset.height <= sourceHeight) chosen = key;
  }
  return chosen;
}

/**
 * The largest preset H.264 may use, and the frame rate that goes with it.
 *
 * The TeamSpeak client answers an H.264 offer with
 * `profile-level-id=42e01f` — Constrained Baseline **level 3.1** — whatever
 * level was offered. Observed directly: offering 42e028 (level 4.0, which is
 * what the encoder stamps for 1080p) comes back as 42e01f.
 *
 * Level 3.1 allows 3600 macroblocks at 108000 per second, which is exactly
 * 1280x720 at 30fps. A 1080p H.264 stream is therefore one the client has
 * already said it cannot decode: it negotiates, connects, receives every
 * packet, and renders nothing.
 *
 * VP8 and VP9 carry no level in their SDP and are not capped.
 */
export const H264_MAX_PRESET = '720p';
export const H264_MAX_FRAMERATE = 30;

/**
 * Hold a preset inside what the codec's receiver will accept.
 *
 * Only ever reduces, like presetForHeight — the two compose, and whichever
 * binds harder wins.
 */
export function presetForCodec(requested: string, codec: string): string {
  if (codec !== 'h264') return requested;

  const wanted = STREAM_PRESETS[requested];
  const ceiling = STREAM_PRESETS[H264_MAX_PRESET];
  if (!wanted || !ceiling) return requested;

  return wanted.height > ceiling.height ? H264_MAX_PRESET : requested;
}

/** Hold a frame rate inside what the codec's receiver will accept. */
export function framerateForCodec(requested: number, codec: string): number {
  if (codec !== 'h264') return requested;
  return Math.min(requested, H264_MAX_FRAMERATE);
}
