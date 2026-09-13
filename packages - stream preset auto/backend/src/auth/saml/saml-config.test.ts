import { describe, it, expect } from 'vitest';
import { normalizeCert } from './saml-config.js';

describe('normalizeCert', () => {
  it('laisse un PEM déjà encadré intact (hors espaces)', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
    expect(normalizeCert(pem)).toContain('BEGIN CERTIFICATE');
  });
  it('encadre un corps base64 nu', () => {
    const out = normalizeCert('AAAABBBBCCCC');
    expect(out.startsWith('-----BEGIN CERTIFICATE-----')).toBe(true);
    expect(out.trim().endsWith('-----END CERTIFICATE-----')).toBe(true);
  });
});
