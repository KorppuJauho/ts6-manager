import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { validatePassword, loadPasswordPolicy, savePasswordPolicy, type PasswordPolicy } from '../utils/validate-password.js';

const VALID_ROLES = ['admin', 'viewer'];

export const userRoutes: Router = Router();

userRoutes.use(requireRole('admin'));

// GET /api/users/password-policy — current global password policy
userRoutes.get('/password-policy', async (req: Request, res: Response, next) => {
  try {
    res.json(await loadPasswordPolicy(req.app.locals.prisma));
  } catch (err) { next(err); }
});

// PUT /api/users/password-policy — update the global password policy
userRoutes.put('/password-policy', async (req: Request, res: Response, next) => {
  try {
    const minLength = parseInt(req.body.minLength);
    if (isNaN(minLength) || minLength < 1 || minLength > 128) {
      throw new AppError(400, 'minLength must be between 1 and 128');
    }
    const policy: PasswordPolicy = { minLength, requireComplexity: !!req.body.requireComplexity };
    await savePasswordPolicy(req.app.locals.prisma, policy);
    res.json(policy);
  } catch (err) { next(err); }
});

/**
 * The servers a request grants, or undefined when it leaves them unchanged.
 * Grants only matter to viewers: admins reach every server anyway.
 */
async function readServerIds(prisma: any, value: unknown): Promise<number[] | undefined> {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new AppError(400, 'serverIds must be an array');
  const ids = [...new Set(value.map((v) => Number(v)))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new AppError(400, 'serverIds must be server ids');
  if (ids.length && await prisma.tsServerConfig.count({ where: { id: { in: ids } } }) !== ids.length) {
    throw new AppError(400, 'Unknown server in serverIds');
  }
  return ids;
}

function grantWrites(prisma: any, userId: number, ids: number[]) {
  return [
    prisma.userServerAccess.deleteMany({ where: { userId } }),
    ...(ids.length ? [prisma.userServerAccess.createMany({ data: ids.map((serverConfigId) => ({ userId, serverConfigId })) })] : []),
  ];
}

userRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const users = await prisma.user.findMany({
      select: {
        id: true, username: true, displayName: true, role: true, enabled: true, createdAt: true, lastLoginAt: true,
        serverAccess: { select: { serverConfigId: true } },
      },
      orderBy: { id: 'asc' },
    });
    res.json(users.map(({ serverAccess, ...u }: any) => ({
      ...u,
      serverIds: serverAccess.map((a: { serverConfigId: number }) => a.serverConfigId),
    })));
  } catch (err) { next(err); }
});

userRoutes.post('/', async (req: Request, res: Response, next) => {
  try {
    const { username, password, displayName, role } = req.body;
    if (!username || !password || !displayName) throw new AppError(400, 'Username, password, and display name required');

    const prisma = req.app.locals.prisma;
    const pwError = validatePassword(password, await loadPasswordPolicy(prisma));
    if (pwError) throw new AppError(400, pwError);

    const assignedRole = role || 'viewer';
    if (!VALID_ROLES.includes(assignedRole)) throw new AppError(400, `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
    const serverIds = await readServerIds(prisma, req.body.serverIds);
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        username, passwordHash, displayName, role: assignedRole,
        mustChangePassword: !!req.body.mustChangePassword,
        ...(serverIds?.length ? { serverAccess: { create: serverIds.map((serverConfigId) => ({ serverConfigId })) } } : {}),
      },
    });

    res.status(201).json({ id: user.id, username: user.username });
  } catch (err) { next(err); }
});

userRoutes.put('/:userId', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(String(req.params.userId));
    const data: any = {};

    if (req.body.displayName !== undefined) data.displayName = req.body.displayName;
    if (req.body.role !== undefined) {
      if (!VALID_ROLES.includes(req.body.role)) throw new AppError(400, `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`);
      data.role = req.body.role;
    }
    if (req.body.enabled !== undefined) data.enabled = req.body.enabled;
    if (req.body.password) {
      const pwError = validatePassword(req.body.password, await loadPasswordPolicy(prisma));
      if (pwError) throw new AppError(400, pwError);
      data.passwordHash = await bcrypt.hash(req.body.password, 12);
    }
    if (req.body.mustChangePassword !== undefined) data.mustChangePassword = !!req.body.mustChangePassword;

    const isDemoting = data.enabled === false || data.role === 'viewer';
    if (isDemoting) {
      // Self-protection: cannot disable or demote your own account
      if (id === req.user!.id) throw new AppError(400, 'Cannot disable or demote your own account');

      // Last-admin protection: if target is currently an enabled admin, ensure others remain
      const target = await prisma.user.findUnique({ where: { id }, select: { role: true, enabled: true } });
      if (target?.role === 'admin' && target.enabled) {
        const otherAdmins = await prisma.user.count({ where: { role: 'admin', enabled: true, id: { not: id } } });
        if (otherAdmins === 0) throw new AppError(400, 'Cannot remove the last administrator');
      }
    }

    const serverIds = await readServerIds(prisma, req.body.serverIds);
    await prisma.$transaction([
      prisma.user.update({ where: { id }, data }),
      ...(serverIds ? grantWrites(prisma, id, serverIds) : []),
    ]);
    res.status(204).send();
  } catch (err) { next(err); }
});

userRoutes.delete('/:userId', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const id = parseInt(String(req.params.userId));
    if (id === req.user!.id) throw new AppError(400, 'Cannot delete your own account');

    const target = await prisma.user.findUnique({ where: { id }, select: { role: true, enabled: true } });
    if (target?.role === 'admin' && target.enabled) {
      const otherAdmins = await prisma.user.count({ where: { role: 'admin', enabled: true, id: { not: id } } });
      if (otherAdmins === 0) throw new AppError(400, 'Cannot remove the last administrator');
    }

    await prisma.user.delete({ where: { id } });
    res.status(204).send();
  } catch (err) { next(err); }
});
