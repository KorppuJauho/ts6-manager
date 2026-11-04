import { describe, it, expect } from 'vitest';
import { canLocalLogin, requirePasswordHash } from './auth.routes.js';
import { AppError } from '../middleware/error-handler.js';

describe('canLocalLogin', () => {
  it('refuses an account without a password hash (once provisioned by SSO)', () => {
    expect(canLocalLogin({ enabled: true, passwordHash: null })).toBe(false);
  });
  it('refuses a disabled account', () => {
    expect(canLocalLogin({ enabled: false, passwordHash: 'x' })).toBe(false);
  });
  it('allows an enabled account with a hash', () => {
    expect(canLocalLogin({ enabled: true, passwordHash: 'x' })).toBe(true);
  });
});

describe('requirePasswordHash', () => {
  it('rejects an account with no password with a 400 that says what to do', () => {
    expect(() => requirePasswordHash(null)).toThrow(AppError);
    try {
      requirePasswordHash(null);
    } catch (err) {
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).message).toBe('This account has no password; ask an administrator to set one');
    }
  });
  it('returns the hash of an account that has one', () => {
    expect(requirePasswordHash('hashed')).toBe('hashed');
  });
});
