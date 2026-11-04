export type UserRole = 'admin' | 'viewer';

/**
 * Token classes. Both are signed with the same secret, so every verifier must
 * assert the class it expects — otherwise the password-change token, issued
 * after the password step alone, is accepted as a full session and the forced
 * change is skipped.
 */
export type TokenType = 'access' | 'pwchange';

export interface JwtPayload {
  id: number;
  username: string;
  role: UserRole;
  typ?: TokenType;
  iat?: number;
  exp?: number;
}
