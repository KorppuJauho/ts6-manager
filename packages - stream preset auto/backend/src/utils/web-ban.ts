import type { PrismaClient } from '../../generated/prisma/index.js';
import { normalizeIp } from './geo.js';

/**
 * True if the IP has an active (non-expired) web ban. Best-effort purges
 * expired rows. Never throws — a DB hiccup must not lock everyone out.
 */
export async function isIpWebBanned(prisma: PrismaClient, rawIp: string): Promise<boolean> {
  const ip = normalizeIp(rawIp);
  if (!ip) return false;
  try {
    const ban = await prisma.webBan.findUnique({ where: { ip } });
    if (!ban) return false;
    if (ban.expiresAt && ban.expiresAt.getTime() <= Date.now()) {
      prisma.webBan.delete({ where: { id: ban.id } }).catch(() => { });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Convert a duration in minutes (0/undefined = permanent) to a future Date or null. */
export function durationToExpiry(durationMinutes: number | undefined): Date | null {
  const m = Number(durationMinutes);
  if (!m || m <= 0) return null;
  return new Date(Date.now() + m * 60_000);
}
