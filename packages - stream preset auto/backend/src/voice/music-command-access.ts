/** Pure helpers for Music Bot command access control. No I/O. */

export type CommandTier = 'open' | 'music' | 'admin';

/** Commands that manage users/notifications — gated by the admin group. */
const ADMIN_COMMANDS = new Set(['move', 'moveall', 'notif']);
/** Commands that are always allowed regardless of configuration. */
const ALWAYS_OPEN = new Set(['help', 'aide']);

export function classifyCommand(command: string): CommandTier {
  if (ALWAYS_OPEN.has(command)) return 'open';
  if (ADMIN_COMMANDS.has(command)) return 'admin';
  return 'music';
}

export interface MusicCommandAccessSettings {
  musicCommandSgid: number | null;
  adminCommandSgid: number | null;
}

/**
 * The server-group id required to run `command`, or null when unrestricted
 * (open command, or no group configured for its tier).
 */
export function requiredSgid(command: string, settings: MusicCommandAccessSettings): number | null {
  const tier = classifyCommand(command);
  if (tier === 'open') return null;
  if (tier === 'admin') return settings.adminCommandSgid ?? null;
  return settings.musicCommandSgid ?? null;
}

/** Parse a TS `client_servergroups` field ("6,7,8") into a number[]. */
export function parseServerGroupIds(raw: string | undefined | null): number[] {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}
