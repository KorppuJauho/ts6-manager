import { Request, Response, NextFunction } from 'express';
import { AppError } from './error-handler.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';

/**
 * Ensures the connection pool has a live client for :configId before the
 * route handler runs, hydrating it from the DB if needed. Turns the former
 * opaque 500 ("No connection configured for server config ID N") into a 404
 * when the connection genuinely doesn't exist or is disabled.
 */
export function ensureConnection() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const pool: ConnectionPool = req.app.locals.connectionPool;
      await pool.getOrLoad(parseInt(String(req.params.configId)));
      next();
    } catch {
      next(new AppError(404, 'Server connection not found or disabled'));
    }
  };
}
