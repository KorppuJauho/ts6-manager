import crypto from 'crypto';

export const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const TRUSTED_COOKIE_NAME = 'ts6_trusted';

export function hashVerifier(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('hex');
}

/** Mint a fresh trusted-device token. The verifier hash is what gets stored. */
export function mintTrustedToken(): {
  selector: string;
  verifier: string;
  cookieValue: string;
  verifierHash: string;
} {
  const selector = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('hex');
  return { selector, verifier, cookieValue: `${selector}.${verifier}`, verifierHash: hashVerifier(verifier) };
}

/** Split a `selector.verifier` cookie value; null if malformed. */
export function splitTrustedToken(value: string): { selector: string; verifier: string } | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { selector: parts[0], verifier: parts[1] };
}

/** Constant-time compare of a presented verifier against the stored hash. */
export function verifierMatches(verifier: string, storedHash: string): boolean {
  const a = Buffer.from(hashVerifier(verifier), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
