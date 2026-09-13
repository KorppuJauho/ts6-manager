/**
 * TeamSpeak rejects a nickname longer than this, so a "now playing" suffix has
 * to be fitted rather than appended.
 */
export const MAX_NICKNAME_LENGTH = 30;

/**
 * The verbose streaming form is mostly punctuation. Below this much room for
 * the title itself it says less than the compact form does, so the compact
 * form wins.
 */
const MIN_TITLE_CHARS = 6;

const ELLIPSIS = '…';

/**
 * Fit `prefix + separator + title + suffix` into the nickname limit by
 * truncating the title, never the bot's own name — the name is how people
 * recognise the bot, the title is what they can lose the tail of.
 *
 * Returns the bare prefix when even one character of title will not fit.
 */
export function fitNickname(prefix: string, separator: string, title: string, suffix = ''): string {
  const full = `${prefix}${separator}${title}${suffix}`;
  if (full.length <= MAX_NICKNAME_LENGTH) return full;

  const available = MAX_NICKNAME_LENGTH - prefix.length - separator.length - suffix.length - 1;
  if (available < 1) return prefix.slice(0, MAX_NICKNAME_LENGTH);

  return `${prefix}${separator}${title.slice(0, available)}${ELLIPSIS}${suffix}`;
}

/** "MusicBot ♪ Song Title" — what the bot is playing from its queue. */
export function nowPlayingNickname(prefix: string, title: string): string {
  return fitNickname(prefix, ' ♪ ', title);
}

/**
 * "MusicBot - Streaming 'MTV3'" — what the bot is streaming to video.
 *
 * Falls back to "MusicBot ▶ MTV3" when the quoted form leaves too little
 * room for the title. A long bot name spends most of the 30 characters on
 * " - Streaming ''", which would otherwise leave a nickname that announces a
 * stream without saying what of.
 */
export function streamingNickname(prefix: string, title: string): string {
  const verboseSeparator = " - Streaming '";
  const available = MAX_NICKNAME_LENGTH - prefix.length - verboseSeparator.length - 1;
  if (available >= Math.min(title.length, MIN_TITLE_CHARS)) {
    return fitNickname(prefix, verboseSeparator, title, "'");
  }
  return fitNickname(prefix, ' ▶ ', title);
}
