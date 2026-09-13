import { describe, it, expect } from 'vitest';
import { isCommandAllowed, parseRoleIds } from './command-permissions.js';

describe('parseRoleIds', () => {
  it('returns [] for null, undefined, empty, or malformed JSON', () => {
    expect(parseRoleIds(null)).toEqual([]);
    expect(parseRoleIds(undefined)).toEqual([]);
    expect(parseRoleIds('')).toEqual([]);
    expect(parseRoleIds('not json')).toEqual([]);
    expect(parseRoleIds('{"a":1}')).toEqual([]);
  });

  it('parses a JSON array of string ids and drops non-strings', () => {
    expect(parseRoleIds('["1","2"]')).toEqual(['1', '2']);
    expect(parseRoleIds('["1",2,null,"3"]')).toEqual(['1', '3']);
  });
});

describe('isCommandAllowed', () => {
  const base = { allowedRoleIds: [] as string[], memberRoleIds: [] as string[], isAdmin: false, isOwner: false };

  it('allows everyone when the allow-list is empty', () => {
    expect(isCommandAllowed({ ...base, allowedRoleIds: [], memberRoleIds: [] })).toBe(true);
  });

  it('allows a member holding one of the allowed roles', () => {
    expect(isCommandAllowed({ ...base, allowedRoleIds: ['a', 'b'], memberRoleIds: ['x', 'b'] })).toBe(true);
  });

  it('denies a member holding none of the allowed roles', () => {
    expect(isCommandAllowed({ ...base, allowedRoleIds: ['a', 'b'], memberRoleIds: ['x', 'y'] })).toBe(false);
  });

  it('allows a Discord admin even without an allowed role', () => {
    expect(isCommandAllowed({ ...base, allowedRoleIds: ['a'], memberRoleIds: [], isAdmin: true })).toBe(true);
  });

  it('allows the guild owner even without an allowed role', () => {
    expect(isCommandAllowed({ ...base, allowedRoleIds: ['a'], memberRoleIds: [], isOwner: true })).toBe(true);
  });
});
