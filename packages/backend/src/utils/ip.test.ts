import { describe, it, expect } from 'vitest';
import { normalizeIp } from './ip.js';

describe('normalizeIp', () => {
  it('unwraps IPv4-mapped IPv6 and strips an IPv4 port', () => {
    expect(normalizeIp('::ffff:8.8.8.8')).toBe('8.8.8.8');
    expect(normalizeIp('8.8.8.8:51234')).toBe('8.8.8.8');
    expect(normalizeIp('2001:4860:4860::8888')).toBe('2001:4860:4860::8888');
  });

  it('returns an empty string for empty input', () => {
    expect(normalizeIp('')).toBe('');
    expect(normalizeIp('  ')).toBe('');
  });
});
