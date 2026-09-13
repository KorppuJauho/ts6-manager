import { describe, it, expect } from 'vitest';
import { buildJournalQuery } from './journal-query.js';

describe('buildJournalQuery', () => {
  it('defaults to web source, createdAt desc', () => {
    const q = buildJournalQuery({});
    expect(q.source).toBe('web');
    expect(q.where).toEqual({ source: 'web' });
    expect(q.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('whitelists the sort field and direction', () => {
    expect(buildJournalQuery({ sort: 'login', dir: 'asc' }).orderBy).toEqual({ login: 'asc' });
    // unknown field falls back to createdAt; unknown dir falls back to desc
    expect(buildJournalQuery({ sort: 'passwordHash', dir: 'sideways' }).orderBy).toEqual({ createdAt: 'desc' });
  });

  it('applies contains filters for login and ip', () => {
    const q = buildJournalQuery({ login: 'alice', ip: '8.8' });
    expect(q.where.login).toEqual({ contains: 'alice' });
    expect(q.where.ip).toEqual({ contains: '8.8' });
  });

  it('treats country LAN as null, otherwise uppercased contains', () => {
    expect(buildJournalQuery({ country: 'lan' }).where.country).toBeNull();
    expect(buildJournalQuery({ country: 'fr' }).where.country).toEqual({ contains: 'FR' });
  });

  it('maps the result filter only on the web source', () => {
    expect(buildJournalQuery({ source: 'web', result: 'failed' }).where.success).toBe(false);
    expect(buildJournalQuery({ source: 'web', result: 'success' }).where.success).toBe(true);
    // result is ignored for teamspeak
    expect(buildJournalQuery({ source: 'teamspeak', result: 'failed' }).where.success).toBeUndefined();
  });

  it('applies hideBots only on teamspeak', () => {
    expect(buildJournalQuery({ source: 'teamspeak', hideBots: 'true' }).where.isBot).toBe(false);
    expect(buildJournalQuery({ source: 'web', hideBots: 'true' }).where.isBot).toBeUndefined();
  });
});
