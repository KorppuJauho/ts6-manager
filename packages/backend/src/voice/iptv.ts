/**
 * IPTV channel list, loaded from an M3U/M3U8 playlist.
 *
 * The playlist URL is configured by an admin in the web UI, not supplied by a
 * TeamSpeak user: !tv only picks a name out of the parsed list, and never
 * passes a URL of its own to the fetcher. It is therefore deliberately *not*
 * run through `validateUrl` — that helper refuses private addresses, and the
 * usual deployment points this at an IPTV proxy on the LAN. What is enforced
 * instead is the scheme, a request timeout and a cap on the response body, so
 * a wrong or hostile URL cannot hang the bot or exhaust memory.
 */

/** Parsed M3U entry: display name (lowercased) -> stream URL. */
export type TvChannelMap = Map<string, string>;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_PLAYLIST_BYTES = 5 * 1024 * 1024;

/** How a channel list is ordered for display. */
export type TvSort = 'name' | 'playlist';

/**
 * Order channel names for listing.
 *
 * "playlist" keeps the order the provider published, which usually groups
 * related channels together; "name" sorts alphabetically, which is easier to
 * scan when the list is long.
 */
export function sortChannelNames(channels: TvChannelMap, sort: TvSort): string[] {
  const names = Array.from(channels.keys());
  return sort === 'name' ? names.sort((a, b) => a.localeCompare(b)) : names;
}

/**
 * Parse M3U text into name -> URL.
 *
 * An M3U entry is a `#EXTINF:` line whose display name is everything after
 * the last comma, followed by the stream URL on a later line. Directives
 * other than #EXTINF are skipped, so #EXTVLCOPT / #EXTGRP between the two do
 * not detach a name from its URL.
 */
export function parseM3u(text: string, filter: string[] = []): TvChannelMap {
  const channels: TvChannelMap = new Map();
  let name = '';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const comma = line.lastIndexOf(',');
      name = comma === -1 ? '' : line.slice(comma + 1).trim().toLowerCase();
      continue;
    }

    if (line.startsWith('#')) continue;
    if (!name) continue;

    if (filter.length === 0 || filter.some((want) => name.includes(want))) {
      channels.set(name, line);
    }
    name = '';
  }

  return channels;
}

/** Fetch and parse the configured playlist. Throws with a usable message. */
export async function loadTvChannels(url: string, filter: string[] = []): Promise<TvChannelMap> {
  if (!url) {
    throw new Error('No IPTV playlist configured.');
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('IPTV playlist URL must be http(s).');
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Playlist fetch failed: HTTP ${res.status}`);
  }

  // Trust neither Content-Length nor its absence: measure what arrives.
  const body = await res.arrayBuffer();
  if (body.byteLength > MAX_PLAYLIST_BYTES) {
    throw new Error(`Playlist too large (${body.byteLength} bytes).`);
  }

  return parseM3u(new TextDecoder().decode(body), filter);
}

/**
 * Find a channel by loose name match: exact first, then substring in either
 * direction with spaces stripped, so "mtv3" matches "mtv 3".
 */
export function matchChannel(channels: TvChannelMap, query: string): string | null {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return null;
  if (channels.has(wanted)) return wanted;

  const squashed = wanted.replace(/\s+/g, '');
  if (!squashed) return null;

  for (const name of channels.keys()) {
    const candidate = name.replace(/\s+/g, '');
    if (candidate.includes(squashed) || squashed.includes(candidate)) {
      return name;
    }
  }
  return null;
}
