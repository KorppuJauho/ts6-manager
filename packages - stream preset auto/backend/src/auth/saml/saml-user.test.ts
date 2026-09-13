import { describe, it, expect } from 'vitest';
import { firstAttr, resolveRole, buildSamlProfile, disambiguateUsername } from './saml-user.js';

const base = {
  attrUsername: 'user', attrEmail: 'email', attrDisplayName: 'dn',
  attrRole: 'groups', roleAdminValue: 'ts6-admins', defaultRole: 'viewer' as const,
};

describe('firstAttr', () => {
  it('returns a scalar value', () => {
    expect(firstAttr({ user: 'bob' }, 'user')).toBe('bob');
  });
  it('returns the first element of an array', () => {
    expect(firstAttr({ groups: ['a', 'b'] }, 'groups')).toBe('a');
  });
  it('returns null if missing', () => {
    expect(firstAttr({}, 'user')).toBeNull();
  });
});

describe('resolveRole', () => {
  it('admin if group value == roleAdminValue', () => {
    expect(resolveRole({ groups: ['x', 'ts6-admins'] }, base)).toBe('admin');
  });
  it('defaultRole if no match', () => {
    expect(resolveRole({ groups: ['x'] }, base)).toBe('viewer');
  });
  it('defaultRole if attrRole not configured', () => {
    expect(resolveRole({ groups: ['ts6-admins'] }, { ...base, attrRole: null })).toBe('viewer');
  });
});

describe('buildSamlProfile', () => {
  it('maps nameID + attributes', () => {
    const p = buildSamlProfile(
      { nameID: 'uid-1', attributes: { user: 'bob', email: 'bob@x.io', dn: 'Bob', groups: ['ts6-admins'] } },
      base,
    );
    expect(p).toEqual({ externalId: 'uid-1', username: 'bob', email: 'bob@x.io', displayName: 'Bob', role: 'admin' });
  });
  it('fallback username=email local-part then nameID, displayName=username', () => {
    const p = buildSamlProfile({ nameID: 'uid-2', attributes: { email: 'jane@x.io' } }, base);
    expect(p.username).toBe('jane');
    expect(p.displayName).toBe('jane');
    expect(p.role).toBe('viewer');
  });
  it('username=nameID if neither username nor email', () => {
    const p = buildSamlProfile({ nameID: 'uid-3', attributes: {} }, base);
    expect(p.username).toBe('uid-3');
  });
});

describe('disambiguateUsername', () => {
  it('returns as-is if free', () => {
    expect(disambiguateUsername('bob', () => false)).toBe('bob');
  });
  it('suffixes until finding a free one', () => {
    const taken = new Set(['bob', 'bob-2']);
    expect(disambiguateUsername('bob', (c) => taken.has(c))).toBe('bob-3');
  });
});
