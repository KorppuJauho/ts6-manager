import { describe, it, expect } from 'vitest';
import { resolveSamlAccount } from './resolve-account.js';
import type { ResolvedSamlProfile } from './saml-user.js';

function makePrisma(initial: any[] = []) {
  const users = [...initial];
  let seq = users.length;
  return {
    users,
    user: {
      findUnique: async ({ where }: any) => {
        if (where.authProvider_externalId) {
          const { authProvider, externalId } = where.authProvider_externalId;
          return users.find((u) => u.authProvider === authProvider && u.externalId === externalId) || null;
        }
        if (where.username) return users.find((u) => u.username === where.username) || null;
        return null;
      },
      findMany: async ({ where }: any) => {
        const prefix = where?.username?.startsWith ?? '';
        return users.filter((u) => u.username.startsWith(prefix)).map((u) => ({ username: u.username }));
      },
      create: async ({ data }: any) => { const u = { id: ++seq, ...data }; users.push(u); return u; },
      update: async ({ where, data }: any) => {
        const u = users.find((x) => x.id === where.id); Object.assign(u, data); return u;
      },
    },
  };
}

const profile: ResolvedSamlProfile = { externalId: 'uid-1', username: 'bob', email: 'b@x.io', displayName: 'Bob', role: 'viewer' };

describe('resolveSamlAccount', () => {
  it('crée un compte JIT quand autoProvision=true', async () => {
    const prisma = makePrisma();
    const r = await resolveSamlAccount(prisma, profile, { autoProvision: true });
    expect('user' in r && r.user.username).toBe('bob');
    expect(prisma.users).toHaveLength(1);
    expect(prisma.users[0].authProvider).toBe('saml');
    expect(prisma.users[0].passwordHash).toBeNull();
  });

  it('échoue quand autoProvision=false et compte inconnu', async () => {
    const prisma = makePrisma();
    const r = await resolveSamlAccount(prisma, profile, { autoProvision: false });
    expect(r).toEqual({ error: 'not_provisioned' });
    expect(prisma.users).toHaveLength(0);
  });

  it('recalcule le rôle et le displayName à chaque login', async () => {
    const prisma = makePrisma([{ id: 1, authProvider: 'saml', externalId: 'uid-1', username: 'bob', displayName: 'Old', role: 'viewer', enabled: true, passwordHash: null }]);
    const r = await resolveSamlAccount(prisma, { ...profile, role: 'admin', displayName: 'New' }, { autoProvision: false });
    expect('user' in r && r.user.role).toBe('admin');
    expect(prisma.users[0].displayName).toBe('New');
  });

  it('refuse un compte désactivé', async () => {
    const prisma = makePrisma([{ id: 1, authProvider: 'saml', externalId: 'uid-1', username: 'bob', role: 'viewer', enabled: false, passwordHash: null }]);
    const r = await resolveSamlAccount(prisma, profile, { autoProvision: false });
    expect(r).toEqual({ error: 'disabled' });
  });

  it('désambiguïse le username en cas de collision à la création', async () => {
    const prisma = makePrisma([{ id: 1, authProvider: 'local', externalId: null, username: 'bob', role: 'viewer', enabled: true, passwordHash: 'x' }]);
    const r = await resolveSamlAccount(prisma, profile, { autoProvision: true });
    expect('user' in r && r.user.username).toBe('bob-2');
  });
});
