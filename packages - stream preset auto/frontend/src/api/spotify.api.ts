import api from './client';

export interface SpotifySettings {
  enabled: boolean;
  clientId: string | null;
  hasClientSecret: boolean;
  maxAlbumTracks: number;
}

export const spotifyApi = {
  settings: (): Promise<SpotifySettings> => api.get('/spotify/settings').then((r) => r.data),
  updateSettings: (data: Partial<SpotifySettings> & { clientSecret?: string }) =>
    api.put('/spotify/settings', data).then((r) => r.data),
};
