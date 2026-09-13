import { describe, it, expect } from 'vitest';
import { canLocalLogin, requirePasswordHash } from './auth.routes.js';
import { AppError } from '../middleware/error-handler.js';

describe('canLocalLogin', () => {
  it('refuse un compte sans passwordHash (compte SAML)', () => {
    expect(canLocalLogin({ enabled: true, passwordHash: null })).toBe(false);
  });
  it('refuse un compte désactivé', () => {
    expect(canLocalLogin({ enabled: false, passwordHash: 'x' })).toBe(false);
  });
  it('autorise un compte local activé avec hash', () => {
    expect(canLocalLogin({ enabled: true, passwordHash: 'x' })).toBe(true);
  });
});

describe('requirePasswordHash', () => {
  it('rejette un compte SSO (passwordHash null) avec une erreur explicite', () => {
    expect(() => requirePasswordHash(null)).toThrow(AppError);
    try {
      requirePasswordHash(null);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).message).toBe('Not available for SSO accounts');
    }
  });
  it('retourne le hash pour un compte local', () => {
    expect(requirePasswordHash('hashed')).toBe('hashed');
  });
});
