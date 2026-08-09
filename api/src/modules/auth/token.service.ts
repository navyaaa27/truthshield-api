import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { JWTPayload, TokenPair } from './auth.types.js';
import { redis } from '../../shared/redis/index.js';
import { AppError } from '../../middleware/error.js';
import { query } from '../../shared/database/pool.js';
import { logger } from '../../utils/logger.js';

/**
 * Generates a signed Access Token (15m expiry) and Refresh Token (7d expiry)
 */
export function generateTokenPair(payload: JWTPayload): TokenPair {
  const cleanPayload = {
    userId: payload.userId,
    orgId: payload.orgId,
    role: payload.role,
  };

  // We cast expiresIn to any to bypass strict union string/number typings in strict compile mode
  const accessToken = jwt.sign(cleanPayload, env.JWT_SECRET, {
    expiresIn: '15m' as any,
  });

  const refreshToken = jwt.sign(cleanPayload, env.JWT_REFRESH_SECRET, {
    expiresIn: '7d' as any,
  });

  return { accessToken, refreshToken };
}

/**
 * Verifies and decodes an access token.
 */
export function verifyAccessToken(token: string): JWTPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET) as JWTPayload;
  } catch (error: any) {
    logger.warn(`[JWT_VERIFY_ERROR]: ${error.message}`);
    throw new AppError('Invalid or expired access token', 401);
  }
}

/**
 * Verifies and decodes a refresh token.
 */
export function verifyRefreshToken(token: string): JWTPayload {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as JWTPayload;
  } catch (error: any) {
    throw new AppError('Invalid or expired refresh token', 401);
  }
}

/**
 * Uses a valid refresh token to rotate and sign a fresh Access/Refresh Token Pair.
 */
export async function refreshTokens(refreshToken: string): Promise<TokenPair> {
  // 1. Verify token cryptographic signature
  const payload = verifyRefreshToken(refreshToken);

  // 2. Check if this refresh token was blacklisted (revoked on logout)
  const isBlacklisted = await redis.get(`blacklist:refresh:${refreshToken}`);
  if (isBlacklisted) {
    throw new AppError('Refresh token has been revoked', 401);
  }

  // 3. Fetch user in database to confirm existence and active status
  const res = await query('SELECT id, org_id, role, is_active FROM users WHERE id = $1', [
    payload.userId,
  ]);
  const user = res.rows[0];

  if (!user) {
    throw new AppError('User not found', 401);
  }
  if (!user.is_active) {
    throw new AppError('User account is deactivated', 401);
  }

  // 4. Generate new credentials
  const newPayload: JWTPayload = {
    userId: user.id,
    orgId: user.org_id,
    role: user.role,
  };

  return generateTokenPair(newPayload);
}
