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
 * Not a preset but a choice alongside them: follow the source. The source is
 * probed and encoded at the largest preset it can fill, up to a configured
 * limit — so a 720p channel streams at 720p instead of being
 * upscaled. A named preset is the opposite: encoded at exactly that size,
 * with no probe, which is also what a single-connection IPTV service needs.
 */
export const AUTO_PRESET = 'auto';

/**
 * The largest preset Auto may choose when no limit is configured. The limit is
 * a setting because the stream is encoded once but sent to each viewer
 * separately: the upload is the bitrate times the audience, and only the
 * operator knows what their connection carries.
 */
export const DEFAULT_AUTO_MAX_PRESET = '2160p';

/** Whether a key names something a stream can be asked for. */
export function isPresetChoice(key: string): boolean {
  return key === AUTO_PRESET || Object.prototype.hasOwnProperty.call(STREAM_PRESETS, key);
}

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
 * Pick the preset Auto encodes at, given its ceiling and the source's own
 * height.
 *
 * Encoding a 720p channel at the 1080p preset upscales it: the picture gains
 * no detail, the encoder spends 5500k carrying interpolated pixels, and the
 * viewer sees a softer image than the source. So the result is capped at the
 * source's height.
 *
 * It only ever goes down from the ceiling, so a 4K source cannot pull Auto
 * past it.
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
 * The preset to encode at. Only Auto consults the source, so only Auto runs
 * the probe: a named preset is encoded as named, and must not open the extra
 * connection a single-connection IPTV service would refuse.
 */
export async function encodePresetFor(
  requested: string,
  probeHeight: () => Promise<number | null>,
  autoMax: string = DEFAULT_AUTO_MAX_PRESET,
): Promise<string> {
  if (requested !== AUTO_PRESET) return requested;
  return presetForHeight(autoMaxOrDefault(autoMax), await probeHeight());
}

/** A configured Auto limit, or the default when it names no preset. */
export function autoMaxOrDefault(autoMax: string): string {
  return Object.prototype.hasOwnProperty.call(STREAM_PRESETS, autoMax) ? autoMax : DEFAULT_AUTO_MAX_PRESET;
}
