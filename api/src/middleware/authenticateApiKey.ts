import { Request, Response, NextFunction } from 'express';
import { ApiKeyService } from '../modules/api-keys/apikey.service.js';
import { authenticate as authenticateJWT } from './authenticate.js';
import { logger } from '../utils/logger.js';

export function getRequiredScopeForRoute(path: string, method: string): string | null {
  const cleanPath = path.split('?')[0].replace(/\/$/, '');

  // POST /v1/analyze -> jobs:create
  if (cleanPath.endsWith('/v1/analyze') && method === 'POST') {
    return 'jobs:create';
  }

  // GET /v1/jobs/:id -> jobs:read
  if (cleanPath.match(/\/v1\/jobs\/[^/]+$/) && method === 'GET') {
    return 'jobs:read';
  }

  // GET /v1/jobs -> jobs:read
  if (cleanPath.endsWith('/v1/jobs') && method === 'GET') {
    return 'jobs:read';
  }

  // POST /v1/assets -> assets:write
  if (cleanPath.endsWith('/v1/assets') && method === 'POST') {
    return 'assets:write';
  }

  // GET /v1/assets -> assets:read
  if (cleanPath.endsWith('/v1/assets') && method === 'GET') {
    return 'assets:read';
  }

  return null;
}

/**
 * Middleware to authenticate client requests using API Keys.
 */
export async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<any> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authorization header is required',
      });
    }

    let token = authHeader;
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }

    if (!token.startsWith('ts_live_')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid API Key format',
      });
    }

    const remoteIp = req.ip || req.socket.remoteAddress || '';
    const validation = await ApiKeyService.validateApiKey(token, remoteIp);

    if (!validation.valid || !validation.apiKey || !validation.org) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'API Key not found or invalid',
      });
    }

    const { apiKey, org } = validation;

    // Route-level Scope check
    const requiredScope = getRequiredScopeForRoute(req.originalUrl || req.url, req.method);
    if (requiredScope) {
      if (!apiKey.scopes || !apiKey.scopes.includes(requiredScope)) {
        return res.status(403).json({
          error: 'Forbidden',
          message: `Insufficient scopes. Required: ${requiredScope}`,
        });
      }
    }

    // Attach request user context
    req.user = {
      userId: null,
      orgId: org.id,
      role: 'api',
      apiKeyId: apiKey.id,
      scopes: apiKey.scopes,
    } as any;

    // Increment api_calls usage
    import('../modules/billing/usage.service.js').then((m) => {
      m.UsageService.incrementUsage(org.id, 'api_calls').catch((err) => {
        logger.error(`[authenticateApiKey] Failed to increment api_calls: ${err.message}`);
      });
    });

    next();
  } catch (err: any) {
    logger.error(`[authenticateApiKey] Middleware error: ${err.message}`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API Key not found or invalid',
    });
  }
}

/**
 * Combined authentication middleware to support BOTH JWT and API Key authentication.
 */
export async function authenticateJWTOrApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<any> {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authorization header is required',
    });
  }

  let token = authHeader;
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  if (token.startsWith('ts_live_')) {
    return authenticateApiKey(req, res, next);
  } else {
    return authenticateJWT(req, res, next);
  }
}
