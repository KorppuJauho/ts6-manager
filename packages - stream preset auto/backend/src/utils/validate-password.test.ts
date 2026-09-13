import { describe, it, expect } from 'vitest';
import { validatePassword } from './validate-password.js';

describe('validatePassword', () => {
  it('enforces only the minimum length when complexity is off', () => {
    const policy = { minLength: 8, requireComplexity: false };
    expect(validatePassword('short', policy)).toMatch(/at least 8/);
    expect(validatePassword('alllowercasenocomplexity', policy)).toBeNull();
  });

  it('uses the configured minimum length', () => {
    expect(validatePassword('abcdefghijk', { minLength: 12, requireComplexity: false })).toMatch(/at least 12/);
    expect(validatePassword('abcdefghijkl', { minLength: 12, requireComplexity: false })).toBeNull();
  });

  it('requires all four character classes when complexity is on', () => {
    const policy = { minLength: 12, requireComplexity: true };
    expect(validatePassword('alllowercase1!', policy)).toMatch(/uppercase/);
    expect(validatePassword('ALLUPPERCASE1!', policy)).toMatch(/lowercase/);
    expect(validatePassword('NoDigitsHere!!', policy)).toMatch(/digit/);
    expect(validatePassword('NoSpecial1234', policy)).toMatch(/special/);
    expect(validatePassword('Str0ng&Passphrase', policy)).toBeNull();
  });

  it('checks length before complexity', () => {
    expect(validatePassword('Ab1!', { minLength: 12, requireComplexity: true })).toMatch(/at least 12/);
  });
});
