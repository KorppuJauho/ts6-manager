import crypto from 'crypto';

const TTL_MS = 120_000;
const codes = new Map<string, { userId: number; expiresAt: number }>();

/** Mint an opaque one-time code bound to a user id. */
export function createSsoCode(userId: number): string {
  const code = crypto.randomBytes(32).toString('hex');
  codes.set(code, { userId, expiresAt: Date.now() + TTL_MS });
  return code;
}

/** Consume a code: returns the user id once, then never again. */
export function consumeSsoCode(code: string): number | null {
  const entry = codes.get(code);
  if (!entry) return null;
  codes.delete(code);
  if (entry.expiresAt < Date.now()) return null;
  return entry.userId;
}
