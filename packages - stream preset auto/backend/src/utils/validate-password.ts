import type { PrismaClient } from '../../generated/prisma/index.js';

export interface PasswordPolicy {
  minLength: number;
  requireComplexity: boolean;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  requireComplexity: true,
};

const KEY_MIN_LENGTH = 'password.minLength';
const KEY_REQUIRE_COMPLEXITY = 'password.requireComplexity';

/** Load the password policy from AppSetting, falling back to defaults. */
export async function loadPasswordPolicy(prisma: PrismaClient): Promise<PasswordPolicy> {
  try {
    const rows = await prisma.appSetting.findMany({
      where: { key: { in: [KEY_MIN_LENGTH, KEY_REQUIRE_COMPLEXITY] } },
    });
    const map = new Map(rows.map((r: any) => [r.key, r.value]));
    const minLength = parseInt(map.get(KEY_MIN_LENGTH) ?? '') || DEFAULT_PASSWORD_POLICY.minLength;
    const complexityRaw = map.get(KEY_REQUIRE_COMPLEXITY);
    return {
      minLength: Math.max(1, minLength),
      requireComplexity: complexityRaw === undefined ? DEFAULT_PASSWORD_POLICY.requireComplexity : complexityRaw === 'true',
    };
  } catch {
    return DEFAULT_PASSWORD_POLICY;
  }
}

/** Persist the password policy. */
export async function savePasswordPolicy(prisma: PrismaClient, policy: PasswordPolicy): Promise<void> {
  const upsert = (key: string, value: string) =>
    prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  await Promise.all([
    upsert(KEY_MIN_LENGTH, String(Math.max(1, Math.floor(policy.minLength)))),
    upsert(KEY_REQUIRE_COMPLEXITY, policy.requireComplexity ? 'true' : 'false'),
  ]);
}

/**
 * Validate a password against the given policy.
 * Returns an error message if invalid, or null if valid.
 */
export function validatePassword(password: string, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): string | null {
  if (password.length < policy.minLength) {
    return `Password must be at least ${policy.minLength} characters long`;
  }
  if (policy.requireComplexity) {
    if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
    if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
    if (!/[0-9]/.test(password)) return 'Password must contain at least one digit';
    if (!/[^A-Za-z0-9]/.test(password)) return 'Password must contain at least one special character';
  }
  return null;
}
