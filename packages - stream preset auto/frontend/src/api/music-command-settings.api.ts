import api from './client';

export interface MusicCommandSettings {
  musicCommandSgid: number | null;
  adminCommandSgid: number | null;
  notifyNowPlaying: boolean;
}

export const musicCommandSettingsApi = {
  get: (): Promise<MusicCommandSettings> =>
    api.get('/music-command-settings').then((r) => r.data),
  update: (data: Partial<MusicCommandSettings>) =>
    api.put('/music-command-settings', data).then((r) => r.data),
};
