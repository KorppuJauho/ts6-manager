import api from './client';

export interface DiscordSettings {
  enabled: boolean;
  hasToken: boolean;
  guildId: string | null;
  notificationsChannelId: string | null;
  statsChannelId: string | null;
  voiceChannelId: string | null;
  statsLiveEnabled: boolean;
  notifyConnections: boolean;
  notifyNowPlaying: boolean;
  notifyChannelId: string | null;
  notifyJoinTemplate: string | null;
  notifyLeaveTemplate: string | null;
  notifyEmbed: boolean;
  notifAutoDeleteSeconds: number;
  notifyAway: boolean;
  notifyAwayTemplate: string | null;
  notifyBackTemplate: string | null;
  flowMessageTrigger: boolean;
  commandRoleIds: string[];
  defaultMusicBotId: number | null;
  serverConfigId: number | null;
  virtualServerId: number;
}

export interface DiscordStatus {
  enabled: boolean;
  running: boolean;
  error: string | null;
  guildName: string | null;
  warnings: string[];
}

export const discordApi = {
  settings: (): Promise<DiscordSettings> => api.get('/discord/settings').then((r) => r.data),
  updateSettings: (data: Partial<DiscordSettings> & { botToken?: string }) =>
    api.put('/discord/settings', data, { timeout: 30000 }).then((r) => r.data),
  status: (): Promise<DiscordStatus> => api.get('/discord/status').then((r) => r.data),
  guilds: (): Promise<Array<{ id: string; name: string }>> => api.get('/discord/guilds').then((r) => r.data),
  channels: (): Promise<{ text: Array<{ id: string; name: string }>; voice: Array<{ id: string; name: string }> }> =>
    api.get('/discord/channels').then((r) => r.data),
  roles: (): Promise<Array<{ id: string; name: string; color: number }>> =>
    api.get('/discord/roles').then((r) => r.data),
  tsChannels: (): Promise<Array<{ id: string; name: string }>> => api.get('/discord/ts-channels').then((r) => r.data),
};
