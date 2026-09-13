import { searchYouTube, type YouTubeSearchResult } from './youtube.js';

/**
 * Spotify does not allow audio downloads. This module uses the Spotify Web
 * API only to resolve track/album METADATA, then finds the best matching
 * YouTube video; playback always goes through the existing yt-dlp pipeline.
 */

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
  requestTimeoutMs: number;
}

export interface SpotifyTrackInfo {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  spotifyUrl: string;
  isrc?: string;
}

export interface SpotifyResolvedInput {
  type: 'track' | 'album';
  name: string;
  tracks: SpotifyTrackInfo[];
}

type SpotifyArtist = { name?: string };

type SpotifyTrackObject = {
  id: string;
  name: string;
  duration_ms?: number;
  artists?: SpotifyArtist[];
  album?: { name?: string; artists?: SpotifyArtist[] };
  external_urls?: { spotify?: string };
  external_ids?: { isrc?: string };
};

type SpotifyAlbumObject = {
  id: string;
  name: string;
  artists?: SpotifyArtist[];
  external_urls?: { spotify?: string };
  tracks?: { items?: SpotifyTrackObject[]; next?: string | null };
};

// Access token cached per clientId (client-credentials flow).
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export function isSpotifyUrl(input: string): boolean {
  return /(?:open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:track|album)\/|spotify:(?:track|album):)/i.test(input);
}

function parseSpotifyInput(input: string): { type: 'track' | 'album'; id: string } | null {
  const s = String(input || '').trim().split(/\s+/)[0];

  const urlMatch = s.match(
    /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album)\/([A-Za-z0-9]+)(?:\?.*)?$/i,
  );
  if (urlMatch) return { type: urlMatch[1].toLowerCase() as 'track' | 'album', id: urlMatch[2] };

  const uriMatch = s.match(/^spotify:(track|album):([A-Za-z0-9]+)$/i);
  if (uriMatch) return { type: uriMatch[1].toLowerCase() as 'track' | 'album', id: uriMatch[2] };

  return null;
}

function artistNames(artists?: SpotifyArtist[]): string {
  return (artists || []).map((a) => a.name || '').filter(Boolean).join(', ');
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getSpotifyToken(config: SpotifyConfig): Promise<string> {
  const cached = tokenCache.get(config.clientId);
  if (cached && Date.now() < cached.expiresAt - 60000) return cached.token;

  if (!config.clientId || !config.clientSecret) {
    throw new Error('Spotify non configuré (Settings → Spotify)');
  }

  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const res = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  }, config.requestTimeoutMs);

  if (!res.ok) throw new Error(`Spotify token failed: HTTP ${res.status}`);

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('Spotify token missing');

  tokenCache.set(config.clientId, {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  });
  return data.access_token;
}

async function spotifyGet<T>(pathOrUrl: string, config: SpotifyConfig): Promise<T> {
  const token = await getSpotifyToken(config);
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://api.spotify.com/v1${pathOrUrl}`;
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }, config.requestTimeoutMs);
  if (!res.ok) throw new Error(`Spotify API failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

function toTrackInfo(track: SpotifyTrackObject, albumName = '', fallbackArtist = ''): SpotifyTrackInfo {
  const artist = artistNames(track.artists) || fallbackArtist || 'Unknown Artist';
  return {
    id: track.id,
    title: track.name || 'Unknown Title',
    artist,
    album: albumName || track.album?.name || '',
    durationMs: Number(track.duration_ms || 0),
    spotifyUrl: track.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`,
    isrc: track.external_ids?.isrc || '',
  };
}

export async function resolveSpotifyInput(input: string, config: SpotifyConfig): Promise<SpotifyResolvedInput> {
  const parsed = parseSpotifyInput(input);
  if (!parsed) throw new Error('Lien Spotify invalide (track ou album uniquement)');

  if (parsed.type === 'track') {
    const track = await spotifyGet<SpotifyTrackObject>(`/tracks/${encodeURIComponent(parsed.id)}`, config);
    const info = toTrackInfo(track);
    return { type: 'track', name: `${info.artist} - ${info.title}`, tracks: [info] };
  }

  const album = await spotifyGet<SpotifyAlbumObject>(`/albums/${encodeURIComponent(parsed.id)}`, config);
  const albumName = album.name || '';
  const albumArtist = artistNames(album.artists);
  const tracks: SpotifyTrackInfo[] = [];

  for (const item of album.tracks?.items || []) tracks.push(toTrackInfo(item, albumName, albumArtist));

  let next = album.tracks?.next || null;
  while (next) {
    const page = await spotifyGet<{ items?: SpotifyTrackObject[]; next?: string | null }>(next, config);
    for (const item of page.items || []) tracks.push(toTrackInfo(item, albumName, albumArtist));
    next = page.next || null;
  }

  return { type: 'album', name: `${albumArtist} - ${albumName}`, tracks };
}

export function normalizeText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[“”"'`´]/g, '')
    .replace(/\(([^)]*)\)/g, ' ')
    .replace(/\[([^\]]*)\]/g, ' ')
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value).split(' ').filter(Boolean);
}

function countTokenHits(haystack: string, tokens: string[]): number {
  const normalized = normalizeText(haystack);
  return tokens.filter((token) => normalized.includes(token)).length;
}

export function scoreCandidate(track: SpotifyTrackInfo, candidate: YouTubeSearchResult): number {
  let score = 0;

  const titleNorm = normalizeText(track.title);
  const artistNorm = normalizeText(track.artist);
  const videoTitle = normalizeText(candidate.title);
  const channelTitle = normalizeText(candidate.artist);
  const combined = `${videoTitle} ${channelTitle}`;

  const titleTokens = tokenize(track.title);
  const artistTokens = tokenize(track.artist);

  if (titleNorm && videoTitle.includes(titleNorm)) score += 80;

  score += countTokenHits(videoTitle, titleTokens) * 12;
  score += countTokenHits(videoTitle, artistTokens) * 10;
  score += countTokenHits(channelTitle, artistTokens) * 8;

  if (artistNorm && titleNorm && combined.includes(`${artistNorm} ${titleNorm}`)) score += 40;
  if (artistNorm && titleNorm && combined.includes(`${titleNorm} ${artistNorm}`)) score += 40;

  if (/(official|audio|lyrics|lyric|topic)/.test(combined)) score += 12;
  if (/(live|cover|karaoke|nightcore|slowed|reverb|8d|remix|bootleg)/.test(combined)) score -= 35;
  if (/(reaction|review|tutorial|lesson|drum cover|piano cover)/.test(combined)) score -= 50;

  if (track.durationMs && candidate.duration) {
    const wantedSeconds = Math.round(track.durationMs / 1000);
    const diff = Math.abs(wantedSeconds - candidate.duration);
    if (diff <= 2) score += 35;
    else if (diff <= 5) score += 28;
    else if (diff <= 10) score += 18;
    else if (diff <= 20) score += 8;
    else if (diff >= 90) score -= 45;
    else if (diff >= 45) score -= 25;
  }

  if (artistTokens.length > 0 && countTokenHits(combined, artistTokens) === 0) score -= 45;
  if (channelTitle.includes('topic')) score += 10;

  return score;
}

export async function findBestYouTubeForSpotify(track: SpotifyTrackInfo): Promise<YouTubeSearchResult & { score: number }> {
  const queries = [
    `${track.artist} - ${track.title}`,
    `${track.artist} ${track.title} official audio`,
    track.album ? `${track.artist} ${track.title} ${track.album}` : '',
    `${track.title} ${track.artist}`,
  ].filter(Boolean);

  const seen = new Map<string, YouTubeSearchResult>();
  for (const query of queries) {
    try {
      const results = await searchYouTube(query, 5);
      for (const result of results) {
        if (result.id && !seen.has(result.id)) seen.set(result.id, result);
      }
    } catch {
      // try next query
    }
  }

  const scored = [...seen.values()]
    .map((result) => ({ ...result, score: scoreCandidate(track, result) }))
    .sort((a, b) => b.score - a.score);

  if (!scored.length) throw new Error('Aucune correspondance YouTube trouvée');
  if (scored[0].score < 20) {
    throw new Error(`Aucune correspondance fiable pour ${track.artist} - ${track.title}`);
  }
  return scored[0];
}
