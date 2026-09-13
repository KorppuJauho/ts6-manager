export interface CommandPermissionInput {
  allowedRoleIds: string[];
  memberRoleIds: string[];
  isAdmin: boolean;
  isOwner: boolean;
}

/**
 * Gating rule for Discord slash commands:
 *  - empty allow-list  → open to everyone (backward compatible)
 *  - Discord admin / guild owner → always allowed
 *  - otherwise allowed iff the member holds at least one allowed role
 */
export function isCommandAllowed(input: CommandPermissionInput): boolean {
  if (input.allowedRoleIds.length === 0) return true;
  if (input.isAdmin || input.isOwner) return true;
  return input.memberRoleIds.some((r) => input.allowedRoleIds.includes(r));
}

/** Safely parse the JSON-string column into an array of role-id strings. */
export function parseRoleIds(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
