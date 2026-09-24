/**
 * Typed access to the StreamSettings row, shared by the routes, the voice
 * bots and the !tv command.
 *
 * There is exactly one row. It is read on nearly every stream start and on
 * every !tv, so it is cached briefly rather than hit per call; writes
 * invalidate the cache so a change in the web UI takes effect on the next
 * stream rather than up to a TTL later.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

export interface StreamSettingsValue {
  hwAccelEnabled: boolean;
  hwAccelDevice: string;
  hwBackend: string;
  encoderProfile: string;
  defaultPreset: string;
  autoMaxPreset: string;
  iptvEnabled: boolean;
  iptvPlaylistUrl: string;
  iptvChannelFilter: string;
  iptvSort: string;
}

/**
 * Defaults for a database with no row yet. Software VP8 rather than the
 * hardware profile: hardware encoding depends on a GPU being present, passed
 * through and permitted, none of which can be assumed, and a first run that
 * streams is better than one that fails at encoder init.
 */
export const STREAM_SETTINGS_DEFAULTS: StreamSettingsValue = {
  hwAccelEnabled: false,
  hwAccelDevice: '/dev/dri/renderD128',
  hwBackend: 'vaapi',
  encoderProfile: 'vp8_software',
  defaultPreset: 'auto',
  autoMaxPreset: '2160p',
  iptvEnabled: false,
  iptvPlaylistUrl: '',
  iptvChannelFilter: '',
  iptvSort: 'name',
};

export const IPTV_SORTS = ['name', 'playlist'] as const;
export type IptvSort = (typeof IPTV_SORTS)[number];

const CACHE_TTL_MS = 5000;
let cache: { at: number; value: StreamSettingsValue } | null = null;

/** Drop the cache. Call after any write. */
export function invalidateStreamSettings(): void {
  cache = null;
}

export async function getStreamSettings(prisma: PrismaClient): Promise<StreamSettingsValue> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const row = await prisma.streamSettings.findFirst();
  const value: StreamSettingsValue = {
    hwAccelEnabled: row?.hwAccelEnabled ?? STREAM_SETTINGS_DEFAULTS.hwAccelEnabled,
    hwAccelDevice: row?.hwAccelDevice || STREAM_SETTINGS_DEFAULTS.hwAccelDevice,
    hwBackend: isHwBackend(row?.hwBackend) ? row!.hwBackend : STREAM_SETTINGS_DEFAULTS.hwBackend,
    encoderProfile: row?.encoderProfile || STREAM_SETTINGS_DEFAULTS.encoderProfile,
    defaultPreset: row?.defaultPreset || STREAM_SETTINGS_DEFAULTS.defaultPreset,
    autoMaxPreset: row?.autoMaxPreset || STREAM_SETTINGS_DEFAULTS.autoMaxPreset,
    iptvEnabled: row?.iptvEnabled ?? STREAM_SETTINGS_DEFAULTS.iptvEnabled,
    iptvPlaylistUrl: row?.iptvPlaylistUrl ?? STREAM_SETTINGS_DEFAULTS.iptvPlaylistUrl,
    iptvChannelFilter: row?.iptvChannelFilter ?? STREAM_SETTINGS_DEFAULTS.iptvChannelFilter,
    iptvSort: row?.iptvSort || STREAM_SETTINGS_DEFAULTS.iptvSort,
  };
  cache = { at: Date.now(), value };
  return value;
}

/**
 * The hardware backends the sidecar registers, as the second half of a
 * profile key. Which one encodes is a setting: a host's GPU is not something
 * the backend can see, and the sidecar only reports what each one can do.
 */
export const HW_BACKENDS = ['vaapi', 'nvenc'] as const;
export type HwBackend = (typeof HW_BACKENDS)[number];

export function isHwBackend(value: unknown): value is HwBackend {
  return typeof value === 'string' && (HW_BACKENDS as readonly string[]).includes(value);
}

/** The codec half of a profile key: "vp9_vaapi" -> "vp9". */
export function codecFromProfile(profile: string): string {
  const [codec] = profile.split('_');
  return codec || 'vp8';
}

/**
 * Build a profile key from its independent halves.
 *
 * A codec the backend has no encoder for (VP9 on NVENC) still composes — to a
 * key the sidecar does not register, which it resolves to the software
 * encoder for the same codec rather than to its default.
 */
export function composeProfile(codec: string, hardware: boolean, backend: string = 'vaapi'): string {
  return `${codec}_${hardware ? backend : 'software'}`;
}

/**
 * The encoder profile to ask the sidecar for.
 *
 * Codec and backend are independent settings: the stored profile supplies the
 * codec, and the hardware toggle decides the backend. Composing them here
 * rather than trusting the stored key whole means the two can never disagree
 * — which they could before, when a VAAPI profile with the toggle off
 * resolved to an empty string and the sidecar answered with its own default,
 * silently changing the codec as well as the backend.
 *
 * A combination this host cannot run is not this function's problem: the
 * sidecar probes each profile and falls back to the software encoder for the
 * same codec, logging why.
 */
export function effectiveEncoder(settings: StreamSettingsValue): string {
  return composeProfile(codecFromProfile(settings.encoderProfile), settings.hwAccelEnabled, settings.hwBackend);
}

/**
 * The render node to send with a stream, or '' for none. Only VAAPI is
 * addressed by one; NVENC's GPU is whichever the container runtime exposes.
 */
export function effectiveHwDevice(settings: StreamSettingsValue): string {
  return settings.hwAccelEnabled && settings.hwBackend === 'vaapi' ? settings.hwAccelDevice : '';
}

/** Split the stored comma-separated filter into lowercase substrings. */
export function parseChannelFilter(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
