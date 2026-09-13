import api from './client';

export interface StreamSettings {
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

export interface StreamPresetOption {
  key: string;
  label: string;
  width: number;
  height: number;
  bitrate: string;
  framerate: number;
}

export interface EncoderOption {
  key: string;
  label: string;
  mimeType: string;
  payloadType: number;
  hwAccel: string;
  encoder: string;
  /** False when this host's FFmpeg cannot run the profile. */
  available: boolean;
}

export interface StreamSettingsOptions {
  presets: StreamPresetOption[];
  encoders: EncoderOption[];
  /** False when the sidecar could not be probed, so availability is unknown. */
  sidecarReachable: boolean;
  iptvSorts: string[];
}

export const streamSettingsApi = {
  get: (): Promise<StreamSettings> => api.get('/stream-settings').then((r) => r.data),
  options: (): Promise<StreamSettingsOptions> => api.get('/stream-settings/options').then((r) => r.data),
  update: (data: Partial<StreamSettings>): Promise<StreamSettings> =>
    api.put('/stream-settings', data).then((r) => r.data),
};
