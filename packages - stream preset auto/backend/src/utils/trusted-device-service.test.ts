import { describe, it, expect, vi } from 'vitest';
import { resolveTrustedCookie } from './trusted-device-service.js';
import { mintTrustedToken } from './trusted-device.js';

function fakePrisma(device: any) {
  return {
    trustedDevice: {
      findUnique: vi.fn().mockResolvedValue(device),
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

describe('resolveTrustedCookie', () => {
  it('returns null for a missing or malformed cookie', async () => {
    const prisma = fakePrisma(null);
    expect(await resolveTrustedCookie(prisma, undefined)).toBeNull();
    expect(await resolveTrustedCookie(prisma, 'malformed')).toBeNull();
  });

  it('returns the user for a valid, unexpired token', async () => {
    const { selector, cookieValue, verifierHash } = mintTrustedToken();
    const user = { id: 7, username: 'alice', enabled: true };
    const prisma = fakePrisma({
      id: 1, selector, verifierHash,
      expiresAt: new Date(Date.now() + 1000), user,
    });
    const result = await resolveTrustedCookie(prisma, cookieValue);
    expect(result).toEqual(user);
    expect(prisma.trustedDevice.update).toHaveBeenCalled(); // lastUsedAt bumped
  });

  it('rejects and deletes an expired token', async () => {
    const { cookieValue, selector, verifierHash } = mintTrustedToken();
    const prisma = fakePrisma({
      id: 2, selector, verifierHash,
      expiresAt: new Date(Date.now() - 1000), user: { id: 1 },
    });
    expect(await resolveTrustedCookie(prisma, cookieValue)).toBeNull();
    expect(prisma.trustedDevice.delete).toHaveBeenCalled();
  });

  it('rejects a tampered verifier', async () => {
    const { selector, verifierHash } = mintTrustedToken();
    const prisma = fakePrisma({
      id: 3, selector, verifierHash,
      expiresAt: new Date(Date.now() + 1000), user: { id: 1 },
    });
    const tampered = `${selector}.${'0'.repeat(64)}`;
    expect(await resolveTrustedCookie(prisma, tampered)).toBeNull();
    expect(prisma.trustedDevice.delete).toHaveBeenCalled();
  });
});
