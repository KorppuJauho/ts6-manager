import { describe, it, expect } from 'vitest';
import { mintTrustedToken, hashVerifier, splitTrustedToken, verifierMatches, TRUSTED_DEVICE_TTL_MS } from './trusted-device.js';

describe('trusted-device token', () => {
  it('mints a selector.verifier token plus the verifier hash', () => {
    const { selector, verifier, cookieValue, verifierHash } = mintTrustedToken();
    expect(cookieValue).toBe(`${selector}.${verifier}`);
    expect(selector).toMatch(/^[0-9a-f]{32}$/);  // 16 bytes hex
    expect(verifier).toMatch(/^[0-9a-f]{64}$/);   // 32 bytes hex
    expect(verifierHash).toBe(hashVerifier(verifier));
  });

  it('splits a cookie value into selector and verifier', () => {
    expect(splitTrustedToken('aaaa.bbbb')).toEqual({ selector: 'aaaa', verifier: 'bbbb' });
  });

  it('returns null for a malformed cookie value', () => {
    expect(splitTrustedToken('no-dot')).toBeNull();
    expect(splitTrustedToken('a.b.c')).toBeNull();
    expect(splitTrustedToken('')).toBeNull();
  });

  it('hashes the verifier deterministically', () => {
    expect(hashVerifier('abc')).toBe(hashVerifier('abc'));
    expect(hashVerifier('abc')).not.toBe(hashVerifier('abd'));
  });

  it('exposes a 30-day TTL in ms', () => {
    expect(TRUSTED_DEVICE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('verifierMatches', () => {
  it('accepts the right verifier and rejects a wrong one', () => {
    const { verifier, verifierHash } = mintTrustedToken();
    expect(verifierMatches(verifier, verifierHash)).toBe(true);
    expect(verifierMatches('deadbeef', verifierHash)).toBe(false);
  });
});
