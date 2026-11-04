import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { config } from '../config.js';

/** Issue access + refresh tokens and the user payload (login and the forced password change). */
export async function issueSession(prisma: any, user: any) {
  const payload = { typ: 'access', id: user.id, username: user.username, role: user.role };
  const accessToken = jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtAccessExpiry } as jwt.SignOptions);
  const refreshToken = crypto.randomBytes(64).toString('hex');
  const family = nanoid();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await prisma.refreshToken.create({ data: { token: refreshToken, userId: user.id, expiresAt, family } });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
  };
}
