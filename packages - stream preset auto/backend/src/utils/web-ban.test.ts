import { describe, it, expect, vi } from 'vitest';
import { isIpWebBanned, durationToExpiry } from './web-ban.js';

function prismaWith(ban: any) {
  return {
    webBan: {
      findUnique: vi.fn(async () => ban),
      delete: vi.fn(async () => ({})),
    },
  } as any;
}

describe('durationToExpiry', () => {
  it('returns null for 0/undefined (permanent)', () => {
    expect(durationToExpiry(0)).toBeNull();
    expect(durationToExpiry(undefined)).toBeNull();
  });
  it('returns a future date for positive minutes', () => {
    const d = durationToExpiry(10)!;
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('isIpWebBanned', () => {
  it('false when no ban exists', async () => {
    expect(await isIpWebBanned(prismaWith(null), '8.8.8.8')).toBe(false);
  });
  it('true for a permanent ban', async () => {
    expect(await isIpWebBanned(prismaWith({ id: 1, ip: '8.8.8.8', expiresAt: null }), '8.8.8.8')).toBe(true);
  });
  it('true for a ban expiring in the future', async () => {
    const future = new Date(Date.now() + 60_000);
    expect(await isIpWebBanned(prismaWith({ id: 1, ip: '8.8.8.8', expiresAt: future }), '8.8.8.8')).toBe(true);
  });
  it('false (and purges) for an expired ban', async () => {
    const past = new Date(Date.now() - 60_000);
    const prisma = prismaWith({ id: 1, ip: '8.8.8.8', expiresAt: past });
    expect(await isIpWebBanned(prisma, '8.8.8.8')).toBe(false);
    expect(prisma.webBan.delete).toHaveBeenCalled();
  });
  it('normalizes IPv4-mapped IPv6 before lookup', async () => {
    const prisma = prismaWith({ id: 1, ip: '8.8.8.8', expiresAt: null });
    await isIpWebBanned(prisma, '::ffff:8.8.8.8');
    expect(prisma.webBan.findUnique).toHaveBeenCalledWith({ where: { ip: '8.8.8.8' } });
  });
});
