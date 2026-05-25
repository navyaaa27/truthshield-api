import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import { redis } from '../shared/redis/index.js';
import { AppError } from './error.js';

/**
 * Express middleware to extract, verify, and authorize a Bearer Access Token.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Authorization header with Bearer token is required', 401);
    }

    const token = authHeader.substring(7).trim();

    // 1. Decrypt and check cryptographic signature
    const payload = verifyAccessToken(token);

    // 2. Check if token is blacklisted in Redis
    const isBlacklisted = await redis.get(`blacklist:access:${token}`);
    if (isBlacklisted) {
      throw new AppError('Access token has been revoked', 401);
    }

    // 3. Attach payload to request context
    req.user = {
      userId: payload.userId,
      email: '',
      role: payload.role,
      organizationId: payload.orgId,
      orgId: payload.orgId, // attach both to support multiple client configurations
    } as any;

    next();
  } catch (error) {
    next(error);
  }
}
