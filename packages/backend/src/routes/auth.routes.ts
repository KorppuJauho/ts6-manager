import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { AppError } from '../middleware/error-handler.js';
import { validatePassword, loadPasswordPolicy } from '../utils/validate-password.js';
import { issueSession } from '../auth/session.js';

export const authRoutes: Router = Router();

/** A user can attempt local password login only if enabled and has a local password. */
export function canLocalLogin(user: { enabled: boolean; passwordHash: string | null } | null): boolean {
  return !!user && user.enabled && !!user.passwordHash;
}

// Endpoints that re-verify the current password must reject an account with no
// password before reaching bcrypt.compare, which throws on null. Accounts once
// provisioned by SSO have none until an administrator sets one.
export function requirePasswordHash(passwordHash: string | null): string {
  if (!passwordHash) throw new AppError(400, 'This account has no password; ask an administrator to set one');
  return passwordHash;
}

// Short-lived token proving auth fully passed, scoped to the forced password change.
function signChangeToken(userId: number): string {
  return jwt.sign({ typ: 'pwchange', pwchange: true, id: userId }, config.jwtSecret, { expiresIn: '10m' } as jwt.SignOptions);
}
function verifyChangeToken(token: string): number {
  const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as any;
  if (payload?.typ !== 'pwchange' || !payload.pwchange || !payload.id) throw new AppError(401, 'Invalid session');
  return payload.id;
}

authRoutes.post('/login', async (req: Request, res: Response, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) throw new AppError(400, 'Username and password required');

    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { username } });

    if (!canLocalLogin(user)) {
      throw new AppError(401, 'Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.passwordHash as string);
    if (!valid) {
      throw new AppError(401, 'Invalid credentials');
    }

    // A forced password change comes before any session.
    if (user.mustChangePassword) {
      res.json({ mustChangePassword: true, changeToken: signChangeToken(user.id) });
      return;
    }

    res.json(await issueSession(prisma, user));
  } catch (err) { next(err); }
});

// Forced password change at login: verify current password, set the new one
// (policy-checked), clear the flag, then issue the session.
authRoutes.post('/login/change-password', async (req: Request, res: Response, next) => {
  try {
    const { changeToken, currentPassword, newPassword } = req.body;
    if (!changeToken || !currentPassword || !newPassword) throw new AppError(400, 'All fields required');

    const userId = verifyChangeToken(changeToken);
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.enabled) throw new AppError(401, 'Invalid session');

    const valid = await bcrypt.compare(currentPassword, requirePasswordHash(user.passwordHash));
    if (!valid) throw new AppError(401, 'Current password is incorrect');

    const pwError = validatePassword(newPassword, await loadPasswordPolicy(prisma));
    if (pwError) throw new AppError(400, pwError);

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false },
    });
    // Invalidate any existing refresh tokens, then issue the session
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
    res.json(await issueSession(prisma, updated));
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      return next(new AppError(401, 'Session expired, please log in again'));
    }
    next(err);
  }
});

authRoutes.post('/refresh', async (req: Request, res: Response, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new AppError(400, 'Refresh token required');

    const prisma = req.app.locals.prisma;
    const stored = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    });

    if (!stored) {
      // H5: Token not found — check if it was already used (reuse detection)
      const replaced = await prisma.refreshToken.findFirst({
        where: { replacedBy: refreshToken },
      });
      if (replaced) {
        // Reuse detected! Revoke entire token family
        console.warn(`[SECURITY] Refresh token reuse detected for user ${replaced.userId}. Revoking all tokens.`);
        await prisma.refreshToken.deleteMany({ where: { userId: replaced.userId } });
      }
      throw new AppError(401, 'Invalid refresh token');
    }

    if (stored.expiresAt < new Date() || !stored.user.enabled) {
      await prisma.refreshToken.delete({ where: { id: stored.id } });
      throw new AppError(401, 'Invalid refresh token');
    }

    // Rotate: mark old token as replaced, create new one in same family
    const newRefreshToken = crypto.randomBytes(64).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Atomically claim this token for rotation. updateMany never throws on a
    // missing/already-claimed row, so two concurrent /refresh calls with the
    // same token can't both crash with P2025: the loser claims 0 rows and gets
    // a clean 401 instead of a 500 (refresh tokens are one-time use by design).
    const claimed = await prisma.refreshToken.updateMany({
      where: { id: stored.id, replacedBy: null },
      data: { replacedBy: newRefreshToken },
    });
    if (claimed.count === 0) {
      throw new AppError(401, 'Invalid refresh token');
    }

    await prisma.refreshToken.create({
      data: { token: newRefreshToken, userId: stored.userId, expiresAt, family: stored.family },
    });

    // Delete old token after creating new one (deleteMany: no throw if gone)
    await prisma.refreshToken.deleteMany({ where: { id: stored.id } });

    const payload = { typ: 'access', id: stored.user.id, username: stored.user.username, role: stored.user.role };
    const accessToken = jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtAccessExpiry } as jwt.SignOptions);

    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (err) { next(err); }
});

authRoutes.post('/logout', async (req: Request, res: Response, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const prisma = req.app.locals.prisma;
      await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
    }
    res.status(204).send();
  } catch (err) { next(err); }
});

authRoutes.get('/me', authMiddleware, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new AppError(404, 'User not found');

    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        language: user.language,
      },
    });
  } catch (err) { next(err); }
});

const SUPPORTED_LANGUAGES = ['en', 'fr', 'de', 'es', 'it'];

// PUT /api/auth/language — persist the current user's UI language
authRoutes.put('/language', authMiddleware, async (req: Request, res: Response, next) => {
  try {
    const { language } = req.body;
    if (!SUPPORTED_LANGUAGES.includes(language)) throw new AppError(400, 'Unsupported language');
    await req.app.locals.prisma.user.update({ where: { id: req.user!.id }, data: { language } });
    res.json({ language });
  } catch (err) { next(err); }
});

authRoutes.put('/password', authMiddleware, async (req: Request, res: Response, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) throw new AppError(400, 'Both passwords required');

    const prisma = req.app.locals.prisma;
    const pwError = validatePassword(newPassword, await loadPasswordPolicy(prisma));
    if (pwError) throw new AppError(400, pwError);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new AppError(404, 'User not found');

    const valid = await bcrypt.compare(currentPassword, requirePasswordHash(user.passwordHash));
    if (!valid) throw new AppError(401, 'Current password is incorrect');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    // Revoke all refresh tokens on password change
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });

    res.status(204).send();
  } catch (err) { next(err); }
});
