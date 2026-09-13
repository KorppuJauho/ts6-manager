import { describe, it, expect } from 'vitest';
import { createSsoCode, consumeSsoCode } from './sso-code-store.js';

describe('sso-code-store', () => {
  it('crée puis consomme un code une seule fois', () => {
    const code = createSsoCode(42);
    expect(consumeSsoCode(code)).toBe(42);
    expect(consumeSsoCode(code)).toBeNull(); // usage unique
  });
  it('retourne null pour un code inconnu', () => {
    expect(consumeSsoCode('nope')).toBeNull();
  });
});
