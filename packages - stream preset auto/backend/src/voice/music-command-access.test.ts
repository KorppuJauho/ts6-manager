import { describe, it, expect } from 'vitest';
import { classifyCommand, requiredSgid, parseServerGroupIds } from './music-command-access.js';

describe('classifyCommand', () => {
  it('treats help/aide as open', () => {
    expect(classifyCommand('help')).toBe('open');
    expect(classifyCommand('aide')).toBe('open');
  });
  it('treats move/moveall/notif as admin', () => {
    expect(classifyCommand('move')).toBe('admin');
    expect(classifyCommand('moveall')).toBe('admin');
    expect(classifyCommand('notif')).toBe('admin');
  });
  it('treats everything else as music', () => {
    expect(classifyCommand('play')).toBe('music');
    expect(classifyCommand('channels')).toBe('music');
  });
});

describe('requiredSgid', () => {
  const settings = { musicCommandSgid: 10, adminCommandSgid: 20 };
  it('returns null for open commands', () => {
    expect(requiredSgid('help', settings)).toBeNull();
  });
  it('returns the admin group for admin commands', () => {
    expect(requiredSgid('moveall', settings)).toBe(20);
  });
  it('returns the music group for music commands', () => {
    expect(requiredSgid('play', settings)).toBe(10);
  });
  it('returns null when the relevant group is unset (open)', () => {
    expect(requiredSgid('play', { musicCommandSgid: null, adminCommandSgid: 20 })).toBeNull();
    expect(requiredSgid('move', { musicCommandSgid: 10, adminCommandSgid: null })).toBeNull();
  });
});

describe('parseServerGroupIds', () => {
  it('parses a comma-separated list', () => {
    expect(parseServerGroupIds('6,7,8')).toEqual([6, 7, 8]);
  });
  it('handles spaces and empties', () => {
    expect(parseServerGroupIds(' 6 , 7 ')).toEqual([6, 7]);
    expect(parseServerGroupIds('')).toEqual([]);
    expect(parseServerGroupIds(undefined)).toEqual([]);
    expect(parseServerGroupIds(null)).toEqual([]);
  });
});
