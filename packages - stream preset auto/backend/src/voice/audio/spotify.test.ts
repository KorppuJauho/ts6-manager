import { describe, it, expect } from 'vitest';
import { isSpotifyUrl, scoreCandidate, normalizeText, type SpotifyTrackInfo } from './spotify.js';

describe('isSpotifyUrl', () => {
  it('matches track and album URLs, including intl and URIs', () => {
    expect(isSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).toBe(true);
    expect(isSpotifyUrl('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3')).toBe(true);
    expect(isSpotifyUrl('https://open.spotify.com/intl-fr/track/4cOdK2wGLETKBW3PvgPWqT')).toBe(true);
    expect(isSpotifyUrl('spotify:track:4cOdK2wGLETKBW3PvgPWqT')).toBe(true);
  });

  it('rejects non-spotify and unsupported entities', () => {
    expect(isSpotifyUrl('https://www.youtube.com/watch?v=abc')).toBe(false);
    expect(isSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DX')).toBe(false);
    expect(isSpotifyUrl('rick astley never gonna')).toBe(false);
  });
});

describe('normalizeText', () => {
  it('strips brackets, quotes and punctuation', () => {
    expect(normalizeText('Song (Remastered) [2009]')).toBe('song');
    expect(normalizeText('Artist — "Title"')).toBe('artist title');
  });
});

describe('scoreCandidate', () => {
  const track: SpotifyTrackInfo = {
    id: 't1', title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours',
    durationMs: 200000, spotifyUrl: '', isrc: '',
  };

  it('ranks an official-audio exact match with matching duration highest', () => {
    const good = scoreCandidate(track, { id: 'a', title: 'The Weeknd - Blinding Lights (Official Audio)', artist: 'The Weeknd - Topic', duration: 200 });
    const bad = scoreCandidate(track, { id: 'b', title: 'Blinding Lights LIVE cover karaoke', artist: 'Random', duration: 320 });
    expect(good).toBeGreaterThan(bad);
    expect(good).toBeGreaterThan(100);
  });

  it('penalizes a missing artist and far-off duration', () => {
    const score = scoreCandidate(track, { id: 'c', title: 'Some unrelated tune', artist: 'Nobody', duration: 30 });
    expect(score).toBeLessThan(20);
  });
});
