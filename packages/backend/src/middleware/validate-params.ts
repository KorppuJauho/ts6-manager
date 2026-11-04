import { Request, Response, NextFunction } from 'express';

const INT_RE = /^\d+$/;

/**
 * Rejects requests whose numeric route params (e.g. :configId) are not
 * plain integers, before they reach Prisma. parseInt() alone
 * lets NaN through ("12abc" → 12, "abc" → NaN).
 */
export function requireIntParams(...names: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const name of names) {
      const value = req.params[name];
      if (value !== undefined && (typeof value !== 'string' || !INT_RE.test(value))) {
        res.status(400).json({ error: `Invalid ${name} parameter` });
        return;
      }
    }
    next();
  };
}
