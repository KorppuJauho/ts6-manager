export interface SamlProfileInput {
  nameID: string;
  attributes: Record<string, unknown>;
}

export interface ResolvedSamlProfile {
  externalId: string;
  username: string;
  email: string | null;
  displayName: string;
  role: 'admin' | 'viewer';
}

/** First scalar value for an attribute (SAML attributes may be arrays). */
export function firstAttr(attributes: Record<string, unknown>, key: string): string | null {
  const v = attributes[key];
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  if (v === undefined || v === null || v === '') return null;
  return String(v);
}

/** All values for an attribute, as strings. */
function allAttr(attributes: Record<string, unknown>, key: string): string[] {
  const v = attributes[key];
  if (Array.isArray(v)) return v.map(String);
  if (v === undefined || v === null || v === '') return [];
  return [String(v)];
}

export function resolveRole(
  attributes: Record<string, unknown>,
  settings: { attrRole: string | null; roleAdminValue: string | null; defaultRole: string },
): 'admin' | 'viewer' {
  if (settings.attrRole && settings.roleAdminValue) {
    const values = allAttr(attributes, settings.attrRole);
    if (values.includes(settings.roleAdminValue)) return 'admin';
  }
  return settings.defaultRole === 'admin' ? 'admin' : 'viewer';
}

export function buildSamlProfile(
  input: SamlProfileInput,
  settings: {
    attrUsername: string; attrEmail: string; attrDisplayName: string;
    attrRole: string | null; roleAdminValue: string | null; defaultRole: string;
  },
): ResolvedSamlProfile {
  const email = firstAttr(input.attributes, settings.attrEmail);
  const usernameAttr = firstAttr(input.attributes, settings.attrUsername);
  const username = usernameAttr || (email ? email.split('@')[0] : null) || input.nameID;
  const displayName = firstAttr(input.attributes, settings.attrDisplayName) || username;
  const role = resolveRole(input.attributes, settings);
  return { externalId: input.nameID, username, email, displayName, role };
}

/** Return `desired`, or `desired-2`, `desired-3`… until `isTaken` is false. */
export function disambiguateUsername(desired: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(desired)) return desired;
  for (let i = 2; ; i++) {
    const candidate = `${desired}-${i}`;
    if (!isTaken(candidate)) return candidate;
  }
}
