import { describe, it, expect } from 'vitest';
import { lookupCountry, normalizeIp } from './geo.js';

describe('normalizeIp', () => {
  it('unwraps IPv4-mapped IPv6 and strips an IPv4 port', () => {
    expect(normalizeIp('::ffff:8.8.8.8')).toBe('8.8.8.8');
    expect(normalizeIp('8.8.8.8:51234')).toBe('8.8.8.8');
    expect(normalizeIp('2001:4860:4860::8888')).toBe('2001:4860:4860::8888');
  });
});

describe('lookupCountry', () => {
  it('flags private/LAN addresses', () => {
    expect(lookupCountry('192.168.1.20')).toEqual({ country: null, isPrivate: true });
    expect(lookupCountry('10.2.2.10')).toEqual({ country: null, isPrivate: true });
    expect(lookupCountry('172.21.0.1')).toEqual({ country: null, isPrivate: true });
    expect(lookupCountry('127.0.0.1')).toEqual({ country: null, isPrivate: true });
    expect(lookupCountry('::1')).toEqual({ country: null, isPrivate: true });
  });

  it('resolves a public IP to a 2-letter country (offline DB)', () => {
    const r = lookupCountry('8.8.8.8'); // Google DNS → US
    expect(r.isPrivate).toBe(false);
    expect(r.country).toBe('US');
  });

  it('never throws on garbage input', () => {
    expect(() => lookupCountry('')).not.toThrow();
    expect(() => lookupCountry('not-an-ip')).not.toThrow();
  });
});
