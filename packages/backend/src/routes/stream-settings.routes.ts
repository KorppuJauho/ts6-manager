/**
 * Video streaming settings — admin only.
 *
 * Covers hardware encoding, the default preset, stream visibility and the
 * IPTV playlist. These were compile-time constants before; the values here
 * are what the voice bots and the !tv command read at stream time.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { AppError } from '../middleware/error-handler.js';
import { requireRole } from '../middleware/rbac.js';
import { STREAM_PRESETS, isPresetChoice } from '../voice/streaming/types.js';
import {
  getStreamSettings,
  invalidateStreamSettings,
  codecFromProfile,
  composeProfile,
  IPTV_SORTS,
  STREAM_SETTINGS_DEFAULTS,
} from '../utils/stream-settings.js';
import { SidecarClient, type EncoderCapability } from '../voice/streaming/sidecar-client.js';

export const streamSettingsRoutes: Router = Router();

streamSettingsRoutes.use(requireRole('admin'));

/**
 * Profiles the UI offers when the sidecar cannot be reached.
 *
 * Marked unavailable rather than omitted: an operator whose sidecar is down
 * should see why the list is empty, not an empty dropdown that looks broken.
 */
const FALLBACK_ENCODERS: EncoderCapability[] = [
  { key: 'vp8_software', label: 'VP8 (software)', mimeType: 'video/VP8', payloadType: 96, hwAccel: '', encoder: 'libvpx', available: false },
  { key: 'vp9_software', label: 'VP9 (software)', mimeType: 'video/VP9', payloadType: 98, hwAccel: '', encoder: 'libvpx-vp9', available: false },
  { key: 'vp8_vaapi', label: 'VP8 (VAAPI hardware)', mimeType: 'video/VP8', payloadType: 96, hwAccel: 'vaapi', encoder: 'vp8_vaapi', available: false },
  { key: 'vp9_vaapi', label: 'VP9 (VAAPI hardware)', mimeType: 'video/VP9', payloadType: 98, hwAccel: 'vaapi', encoder: 'vp9_vaapi', available: false },
  { key: 'h264_software', label: 'H.264 (software)', mimeType: 'video/H264', payloadType: 102, hwAccel: '', encoder: 'libx264', available: false },
  { key: 'h264_vaapi', label: 'H.264 (VAAPI hardware)', mimeType: 'video/H264', payloadType: 102, hwAccel: 'vaapi', encoder: 'h264_vaapi', available: false },
];

/**
 * Display names for codecs whose key does not uppercase into something
 * readable. Anything absent falls back to the uppercased key.
 */
const CODEC_LABELS: Record<string, string> = { h264: 'H.264' };

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Trim a string field, enforcing a maximum length. */
function asText(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (typeof value !== 'string') throw new AppError(400, 'Expected a string');
  const trimmed = value.trim();
  if (trimmed.length > max) throw new AppError(400, `Value exceeds ${max} characters`);
  return trimmed;
}

// GET /api/stream-settings
streamSettingsRoutes.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await getStreamSettings(req.app.locals.prisma);
    res.json({ ...settings, videoCodec: codecFromProfile(settings.encoderProfile) });
  } catch (err) { next(err); }
});

/**
 * GET /api/stream-settings/options — what the UI can offer.
 *
 * Presets come from the backend's own table. Encoders are probed by the
 * sidecar, which test-encodes with each one: a build can ship vp8_vaapi on a
 * GPU with no VP8 encode entrypoint, so only running it tells the truth. The
 * dropdown can then disable what would fail at stream start.
 */
streamSettingsRoutes.get('/options', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Probe against the configured device: a VAAPI profile's availability is a
    // property of the GPU, not of the FFmpeg build, so the answer differs per
    // render node.
    const settings = await getStreamSettings(req.app.locals.prisma);
    const presets = Object.entries(STREAM_PRESETS).map(([key, p]) => ({
      key,
      label: p.label,
      width: p.width,
      height: p.height,
      bitrate: p.bitrate,
      framerate: p.framerate,
    }));

    let encoders = FALLBACK_ENCODERS;
    let sidecarReachable = false;
    try {
      const client = new SidecarClient(process.env.SIDECAR_URL || 9800);
      const caps = await client.getCapabilities(settings.hwAccelDevice);
      if (Array.isArray(caps?.encoders) && caps.encoders.length > 0) {
        encoders = caps.encoders;
        sidecarReachable = true;
      }
    } catch {
      // Leave the fallback list in place; sidecarReachable tells the UI why
      // everything reads as unavailable.
    }

    // The UI offers a codec and a hardware toggle, not a flat profile list:
    // those are independent choices, and presenting the cross product invites
    // picking a combination that contradicts the toggle. Group the probed
    // profiles so the UI can say which codecs have working hardware support.
    const byCodec = new Map<string, { codec: string; label: string; softwareAvailable: boolean; hardwareAvailable: boolean }>();
    for (const enc of encoders) {
      const codec = codecFromProfile(enc.key);
      const entry = byCodec.get(codec) ?? {
        codec,
        label: CODEC_LABELS[codec] ?? codec.toUpperCase(),
        softwareAvailable: false,
        hardwareAvailable: false,
      };
      if (enc.hwAccel) entry.hardwareAvailable ||= enc.available;
      else entry.softwareAvailable ||= enc.available;
      byCodec.set(codec, entry);
    }

    res.json({
      presets,
      encoders,
      codecs: [...byCodec.values()],
      sidecarReachable,
      iptvSorts: IPTV_SORTS,
    });
  } catch (err) { next(err); }
});

// PUT /api/stream-settings
streamSettingsRoutes.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await getStreamSettings(prisma);
    const body = req.body ?? {};

    const hwAccelEnabled = asBool(body.hwAccelEnabled, current.hwAccelEnabled);

    // The UI sends a codec; the backend half comes from the toggle. An older
    // client sending a whole profile key still works — its codec is taken and
    // its backend discarded, since the toggle is what decides that.
    const videoCodec = asText(body.videoCodec, 32)
      ?? codecFromProfile(asText(body.encoderProfile, 64) ?? current.encoderProfile);
    const encoderProfile = composeProfile(videoCodec, hwAccelEnabled);
    const defaultPreset = asText(body.defaultPreset, 32) ?? current.defaultPreset;
    if (!isPresetChoice(defaultPreset)) {
      throw new AppError(400, `Unknown preset "${defaultPreset}"`);
    }

    const hwAccelDevice = asText(body.hwAccelDevice, 200) ?? current.hwAccelDevice;
    // Mirrors the sidecar's own check: the device must be a path under /dev,
    // so a settings value cannot point FFmpeg at an arbitrary host file.
    if (hwAccelDevice && !/^\/dev\/[A-Za-z0-9._/-]{1,120}$/.test(hwAccelDevice)) {
      throw new AppError(400, 'Encoding device must be a path under /dev');
    }

    const iptvPlaylistUrl = asText(body.iptvPlaylistUrl, 2000) ?? current.iptvPlaylistUrl;
    if (iptvPlaylistUrl && !/^https?:\/\//i.test(iptvPlaylistUrl)) {
      throw new AppError(400, 'Playlist URL must start with http:// or https://');
    }

    const iptvSort = asText(body.iptvSort, 32) ?? current.iptvSort;
    if (!(IPTV_SORTS as readonly string[]).includes(iptvSort)) {
      throw new AppError(400, `Unknown sort "${iptvSort}"`);
    }

    const data = {
      hwAccelEnabled,
      hwAccelDevice: hwAccelDevice || STREAM_SETTINGS_DEFAULTS.hwAccelDevice,
      encoderProfile,
      defaultPreset,
      iptvEnabled: asBool(body.iptvEnabled, current.iptvEnabled),
      iptvPlaylistUrl,
      iptvChannelFilter: asText(body.iptvChannelFilter, 2000) ?? current.iptvChannelFilter,
      iptvSort,
    };

    const existing = await prisma.streamSettings.findFirst();
    if (existing) {
      await prisma.streamSettings.update({ where: { id: existing.id }, data });
    } else {
      await prisma.streamSettings.create({ data });
    }

    invalidateStreamSettings();
    res.json(await getStreamSettings(prisma));
  } catch (err) { next(err); }
});

export default streamSettingsRoutes;
