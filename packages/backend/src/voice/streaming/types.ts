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
