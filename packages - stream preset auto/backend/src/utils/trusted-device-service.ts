import type { Response } from 'express';
import { config } from '../config.js';
import {
  mintTrustedToken,
  splitTrustedToken,
  verifierMatches,
  TRUSTED_DEVICE_TTL_MS,
  TRUSTED_COOKIE_NAME,
} from './trusted-device.js';

const COOKIE_OPTS = {
  httpOnly: true,
  secure: config.nodeEnv === 'production',
  sameSite: 'lax' as const,
  path: '/api/auth',
};

/** Create a TrustedDevice row for the user and set the cookie on the response. */
export async function createTrustedDevice(
  prisma: any,
  res: Response,
  userId: number,
  userAgent: string | undefined,
  ipAddress: string | undefined,
): Promise<void> {
  const { selector, cookieValue, verifierHash } = mintTrustedToken();
  const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_TTL_MS);
  await prisma.trustedDevice.create({
    data: { userId, selector, verifierHash, expiresAt, userAgent: userAgent ?? null, ipAddress: ipAddress ?? null },
  });
  res.cookie(TRUSTED_COOKIE_NAME, cookieValue, { ...COOKIE_OPTS, maxAge: TRUSTED_DEVICE_TTL_MS });
}

/** Clear the trusted cookie on the response. */
export function clearTrustedCookie(res: Response): void {
  res.clearCookie(TRUSTED_COOKIE_NAME, COOKIE_OPTS);
}

/**
 * Resolve a trusted-device cookie to its user.
 * Returns the user row on success, or null (and deletes any stale row) on failure.
 * Does NOT apply account-state gating — callers do that.
 */
export async function resolveTrustedCookie(prisma: any, cookieValue: string | undefined): Promise<any | null> {
  if (!cookieValue) return null;
  const split = splitTrustedToken(cookieValue);
  if (!split) return null;

  const device = await prisma.trustedDevice.findUnique({
    where: { selector: split.selector },
    include: { user: true },
  });
  if (!device) return null;

  if (device.expiresAt < new Date() || !verifierMatches(split.verifier, device.verifierHash)) {
    await prisma.trustedDevice.delete({ where: { id: device.id } }).catch(() => {});
    return null;
  }

  await prisma.trustedDevice.update({ where: { id: device.id }, data: { lastUsedAt: new Date() } });
  return device.user;
}
