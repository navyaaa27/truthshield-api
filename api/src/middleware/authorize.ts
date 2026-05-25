import { Request, Response, NextFunction } from 'express';
import { AppError } from './error.js';

/**
 * Middleware factory to authorize requests by matching req.user.role against allowed roles.
 */
export function authorize(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401));
    }

    if (!roles.includes(req.user.role)) {
      return next(new AppError('Forbidden: Insufficient permissions', 403));
    }

    next();
  };
}
