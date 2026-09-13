export const JOURNAL_SORT_FIELDS = ['createdAt', 'login', 'ip', 'country', 'success'] as const;
export type JournalSortField = (typeof JOURNAL_SORT_FIELDS)[number];

export interface JournalQueryParams {
  source?: string;
  hideBots?: string;
  login?: string;
  ip?: string;
  country?: string;
  result?: string;
  sort?: string;
  dir?: string;
}

/**
 * Build the Prisma where/orderBy for a journal query. Pure and testable.
 * The sort field is whitelisted so an arbitrary column can never reach orderBy.
 */
export function buildJournalQuery(q: JournalQueryParams): { where: any; orderBy: any; source: 'web' | 'teamspeak' } {
  const source: 'web' | 'teamspeak' = q.source === 'teamspeak' ? 'teamspeak' : 'web';
  const where: any = { source };

  if (source === 'teamspeak' && q.hideBots === 'true') where.isBot = false;
  if (q.login) where.login = { contains: q.login };
  if (q.ip) where.ip = { contains: q.ip };

  if (q.country) {
    const c = q.country.trim().toUpperCase();
    where.country = c === 'LAN' ? null : { contains: c };
  }

  if (source === 'web' && q.result) {
    if (q.result === 'success') where.success = true;
    else if (q.result === 'failed') where.success = false;
  }

  const sort: JournalSortField = (JOURNAL_SORT_FIELDS as readonly string[]).includes(q.sort || '')
    ? (q.sort as JournalSortField)
    : 'createdAt';
  const dir: 'asc' | 'desc' = q.dir === 'asc' ? 'asc' : 'desc';

  return { where, orderBy: { [sort]: dir }, source };
}
