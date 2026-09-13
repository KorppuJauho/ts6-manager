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
  encoderProfile: string;
  defaultPreset: string;
  streamPublic: boolean;
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
  encoderProfile: 'vp8_software',
  defaultPreset: '720p',
  streamPublic: true,
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
    encoderProfile: row?.encoderProfile || STREAM_SETTINGS_DEFAULTS.encoderProfile,
    defaultPreset: row?.defaultPreset || STREAM_SETTINGS_DEFAULTS.defaultPreset,
    streamPublic: row?.streamPublic ?? STREAM_SETTINGS_DEFAULTS.streamPublic,
    iptvEnabled: row?.iptvEnabled ?? STREAM_SETTINGS_DEFAULTS.iptvEnabled,
    iptvPlaylistUrl: row?.iptvPlaylistUrl ?? STREAM_SETTINGS_DEFAULTS.iptvPlaylistUrl,
    iptvChannelFilter: row?.iptvChannelFilter ?? STREAM_SETTINGS_DEFAULTS.iptvChannelFilter,
    iptvSort: row?.iptvSort || STREAM_SETTINGS_DEFAULTS.iptvSort,
  };
  cache = { at: Date.now(), value };
  return value;
}

/**
 * The encoder profile to ask the sidecar for.
 *
 * Turning hardware acceleration off drops the hardware *backend*, keeping the
 * codec the operator picked: vp9_vaapi becomes vp9_software, not the sidecar's
 * default. Returning an empty string here instead — as this used to — made the
 * sidecar fall back to its own default of vp8_software, so switching the
 * encoder to VP9 with the toggle off silently produced VP8 and looked like the
 * setting was being ignored.
 *
 * A hardware profile whose software counterpart is not in the registry maps to
 * a key the sidecar does not know; it logs that and falls back, which is the
 * right outcome for a profile combination that cannot run.
 */
export function effectiveEncoder(settings: StreamSettingsValue): string {
  if (settings.hwAccelEnabled) return settings.encoderProfile;
  return settings.encoderProfile.replace(/_(vaapi|nvenc|qsv)$/, '_software');
}

/** Split the stored comma-separated filter into lowercase substrings. */
export function parseChannelFilter(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
