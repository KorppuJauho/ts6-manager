import { describe, it, expect, vi } from 'vitest';
import { ConnectionPool } from './connection-pool.js';

// Minimal Prisma stub: only the two queries the pool uses.
function makePrisma(rows: any[]) {
  return {
    tsServerConfig: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        rows.filter((r) => (where?.enabled === undefined ? true : r.enabled === where.enabled))
      ),
      findUnique: vi.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
    },
  } as any;
}

function row(id: number, overrides: Record<string, any> = {}) {
  return {
    id,
    name: `srv-${id}`,
    host: '10.0.0.1',
    webqueryPort: 10080,
    apiKey: 'plaintext-api-key', // decrypt() passes non-"enc:" values through
    useHttps: false,
    enabled: true,
    ...overrides,
  };
}

describe('ConnectionPool', () => {
  it('initialize loads enabled servers only', async () => {
    const pool = new ConnectionPool(makePrisma([row(1), row(2, { enabled: false })]));
    await pool.initialize();
    expect(pool.hasClient(1)).toBe(true);
    expect(pool.hasClient(2)).toBe(false);
  });

  it('initialize skips a row whose API key cannot be decrypted instead of crashing', async () => {
    // "enc:" prefix with a malformed payload makes decrypt() throw
    const pool = new ConnectionPool(makePrisma([row(1, { apiKey: 'enc:malformed' }), row(2)]));
    await expect(pool.initialize()).resolves.not.toThrow();
    expect(pool.hasClient(1)).toBe(false);
    expect(pool.hasClient(2)).toBe(true);
  });

  it('getOrLoad hydrates a missing client from the DB (no restart needed)', async () => {
    // Regression: connection exists in DB but not in the in-memory pool —
    // previously every request failed with "No connection configured" until restart.
    const pool = new ConnectionPool(makePrisma([row(1)]));
    expect(pool.hasClient(1)).toBe(false);

    const client = await pool.getOrLoad(1);
    expect(client).toBeDefined();
    expect(pool.hasClient(1)).toBe(true);
    // Subsequent sync lookups now succeed
    expect(() => pool.getClient(1)).not.toThrow();
  });

  it('getOrLoad returns the cached client without hitting the DB', async () => {
    const prisma = makePrisma([row(1)]);
    const pool = new ConnectionPool(prisma);
    await pool.getOrLoad(1);
    await pool.getOrLoad(1);
    expect(prisma.tsServerConfig.findUnique).toHaveBeenCalledTimes(1);
  });

  it('getOrLoad rejects for an unknown config ID', async () => {
    const pool = new ConnectionPool(makePrisma([]));
    await expect(pool.getOrLoad(99)).rejects.toThrow(/No connection configured/);
  });

  it('getOrLoad rejects for a disabled connection', async () => {
    const pool = new ConnectionPool(makePrisma([row(1, { enabled: false })]));
    await expect(pool.getOrLoad(1)).rejects.toThrow(/No connection configured/);
    expect(pool.hasClient(1)).toBe(false);
  });
});
