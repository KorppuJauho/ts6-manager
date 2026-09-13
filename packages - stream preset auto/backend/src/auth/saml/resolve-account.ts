import type { ResolvedSamlProfile } from './saml-user.js';
import { disambiguateUsername } from './saml-user.js';

/**
 * Find the SAML user by (authProvider, externalId); create it JIT when allowed,
 * otherwise fail. Existing users get displayName + role re-synced (IdP authoritative).
 */
export async function resolveSamlAccount(
  prisma: any,
  profile: ResolvedSamlProfile,
  settings: { autoProvision: boolean },
): Promise<{ user: any } | { error: 'not_provisioned' | 'disabled' }> {
  const existing = await prisma.user.findUnique({
    where: { authProvider_externalId: { authProvider: 'saml', externalId: profile.externalId } },
  });

  if (existing) {
    if (!existing.enabled) return { error: 'disabled' };
    const user = await prisma.user.update({
      where: { id: existing.id },
      data: { displayName: profile.displayName, role: profile.role },
    });
    return { user };
  }

  if (!settings.autoProvision) return { error: 'not_provisioned' };

  // Resolve a free username (externalId is the identity key, not the username).
  // Fetch existing usernames sharing the prefix in one query, then let the pure
  // disambiguator pick the first free candidate (name, name-2, name-3…).
  const clashes = await prisma.user.findMany({
    where: { username: { startsWith: profile.username } },
    select: { username: true },
  });
  const taken = new Set<string>(clashes.map((c: any) => c.username));
  const username = disambiguateUsername(profile.username, (c) => taken.has(c));

  const user = await prisma.user.create({
    data: {
      username,
      displayName: profile.displayName,
      role: profile.role,
      authProvider: 'saml',
      externalId: profile.externalId,
      passwordHash: null,
      enabled: true,
    },
  });
  return { user };
}
