/**
 * Message catalogue for the bot's TeamSpeak replies.
 *
 * Values that vary are functions rather than templates with placeholders:
 * the arguments are then typed too, so a call site cannot pass the wrong
 * ones.
 */
export interface BotMessages {
  // Playback
  usagePlay: string;
  usagePlayInvalidUrl: string;
  resumed: string;
  paused: string;
  nothingPlaying: string;
  playbackStopped: string;
  loading: string;
  /** `artist` is absent for sources that carry no artist metadata. */
  queued: (artist: string | undefined, title: string, position: number) => string;
  nowPlaying: (artist: string | undefined, title: string) => string;
  failedToPlay: (reason: string) => string;
  failedToQueue: (reason: string) => string;
  skippedTo: (title: string) => string;

  // Spotify
  spotifyNotConfigured: string;
  spotifyResolving: string;
  spotifyUsage: string;
  spotifyAlbum: (name: string, added: number, total: number) => string;
  spotifyQueued: (name: string) => string;
  spotifyNowPlaying: (name: string) => string;
  spotifyFailed: (reason: string) => string;

  // Queue
  queueEmpty: string;
  queueCleared: string;
  queueHeader: (count: number) => string;
  queueInvalidIndex: (count: number) => string;
  queueRemoved: (index: number, title: string) => string;
  queuePlaying: (index: number, title: string) => string;
  queueUsage: string;

  // Radio
  radioNone: string;
  radioHeader: string;
  radioUsage: string;
  radioNotFound: (id: number) => string;
  radioNowPlaying: (station: string) => string;
  queueEmptyStopped: string;
  previousTrack: (title: string) => string;
  noPreviousTrack: string;
  streamStarting: string;
  streamStartedUrl: (url: string) => string;

  // Volume
  volumeIs: (volume: number) => string;
  volumeSet: (volume: number) => string;
  volumeUsage: string;

  // Now playing / info
  infoHeader: string;
  infoTitle: (title: string) => string;
  infoArtist: (artist: string) => string;
  infoDuration: (duration: string) => string;
  infoProgress: (progress: string) => string;
  infoLink: (link: string) => string;

  // Lyrics
  lyricsNoTrack: string;
  lyricsSearching: string;
  lyricsNotFound: (label: string) => string;
  lyricsInstrumental: (artist: string, title: string) => string;

  // Video streaming
  streamUsage: string;
  streamInvalidUrl: string;
  streamSourceChanged: (url: string) => string;
  streamStarted: (preset: string) => string;
  streamFailed: (reason: string) => string;
  floodCleared: string;
  streamNone: string;
  streamStopped: string;
  viewersNone: string;
  viewersHeader: (count: number) => string;

  // Live TV
  tvNotConfigured: string;
  tvNoChannels: string;
  tvLoadFailed: (reason: string) => string;
  tvReloaded: (count: number) => string;
  tvAvailable: (count: number, names: string) => string;
  tvStarting: (channel: string) => string;
  tvNotFound: (query: string) => string;
  tvStartFailed: (reason: string) => string;

  // Errors
  genericError: (reason: string) => string;
  botConfigNotFound: string;

  // Playlist import
  importInProgress: string;
  importFailed: (reason: string) => string;
  importStarted: (playlist: string, total: number) => string;
  importSkipped: (count: number) => string;
  importTruncated: (count: number) => string;
  importNothingToPlay: string;
  importQueuedBehind: string;
  importPlaybackStarts: string;

  // Help
  helpHeader: string;
  helpLines: string[];
}
