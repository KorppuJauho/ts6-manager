import api from './client';

export interface StreamSettings {
  hwAccelEnabled: boolean;
  hwAccelDevice: string;
  /**
   * Stored profile key. The UI edits `videoCodec` instead — the backend half
   * is decided by hwAccelEnabled, so the two cannot contradict.
   */
  encoderProfile: string;
  /** Codec half of encoderProfile, e.g. "vp9". What the UI presents. */
  videoCodec?: string;
  defaultPreset: string;
  autoMaxPreset: string;
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

/** A codec, and whether this host can encode it in software and in hardware. */
export interface CodecOption {
  codec: string;
  label: string;
  softwareAvailable: boolean;
  hardwareAvailable: boolean;
}

export interface StreamSettingsOptions {
  presets: StreamPresetOption[];
  encoders: EncoderOption[];
  codecs: CodecOption[];
  /** False when the sidecar could not be probed, so availability is unknown. */
  sidecarReachable: boolean;
  iptvSorts: string[];
}

export const streamSettingsApi = {
  get: (): Promise<StreamSettings> => api.get('/stream-settings').then((r) => r.data),
  options: (): Promise<StreamSettingsOptions> => api.get('/stream-settings/options').then((r) => r.data),
  update: (data: Partial<StreamSettings> & { videoCodec?: string }): Promise<StreamSettings> =>
    api.put('/stream-settings', data).then((r) => r.data),
};
