import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redisClient } from '../shared/redis/redis.client.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { Request } from 'express';

const skipTrustedIps = (req: Request) => {
  if (!env.RATE_LIMIT_SKIP_TRUSTED_IPS) return false;
  const trusted = env.RATE_LIMIT_SKIP_TRUSTED_IPS.split(',').map((i) => i.trim());
  return trusted.includes(req.ip || '');
};

const skipRateLimiting = (req: Request) => {
  if (process.env.NODE_ENV === 'test' && process.env.ENABLE_SECURITY_MIDDLEWARE !== 'true') {
    return true;
  }
  return skipTrustedIps(req);
};

const createRedisStore = (prefix: string) => {
  if (process.env.MOCK_INFRA === 'true' || redisClient.status !== 'ready') {
    logger.warn(
      `[RateLimit] Redis is offline or MOCK_INFRA is enabled. Falling back to local in-memory store for prefix: ${prefix}`,
    );
    return undefined;
  }
  return new RedisStore({
    // @ts-ignore
    sendCommand: async (...args: string[]) => {
      try {
        return await (redisClient as any).call(...args);
      } catch (err) {
        logger.error(`[RateLimit] Redis store command failed: ${(err as Error).message}`);
        const cmd = args[0]?.toLowerCase();
        if (cmd === 'eval' || cmd === 'evalsha') {
          return [0, 60];
        }
        return 0;
      }
    },
    prefix: `ts:rl:${prefix}:`,
  });
};

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('global'),
  skip: skipRateLimiting,
  handler: (req, res) => {
    logger.warn(`[RateLimit] Global limit exceeded by IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please try again later.',
      },
    });
  },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('auth'),
  skip: skipRateLimiting,
  handler: (req, res, _next, _options) => {
    logger.warn(`[RateLimit] Auth limit exceeded by IP: ${req.ip} on ${req.originalUrl}`);
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many attempts. Try again in 15 minutes.',
        retryAfter: 15 * 60,
      },
    });
  },
});

export const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRedisStore('register'),
  skip: skipRateLimiting,
  handler: (req, res) => {
    logger.warn(`[RateLimit] Registration limit exceeded by IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many registrations from this IP. Try again in 1 hour.',
      },
    });
  },
});

// Used internally by planLimiter.ts
export const createDynamicPlanLimiter = (prefix: string, windowMs: number) =>
  rateLimit({
    windowMs,
    max: (req: Request) => (req as any).planLimit || 10,
    keyGenerator: (req: Request) => (req as any).user?.orgId || req.ip || 'unknown',
    store: createRedisStore(prefix),
    skip: skipRateLimiting,
    validate: { default: false },
    handler: (req, res) => {
      logger.warn(
        `[RateLimit] Plan limit (${prefix}) exceeded for org: ${(req as any).user?.orgId}`,
      );
      res.status(429).json({
        success: false,
        error: {
          code: 'PLAN_LIMIT_EXCEEDED',
          message: 'Upgrade your plan for higher limits',
          currentPlan: (req as any).currentPlan || 'starter',
          limit: (req as any).planLimit,
          upgradeUrl: '/billing/upgrade',
        },
      });
    },
  });

export const uploadLimiter = createDynamicPlanLimiter('uploads', 60 * 60 * 1000);
export const detectionJobLimiter = createDynamicPlanLimiter('jobs', 60 * 60 * 1000);
export const apiKeyLimiter = createDynamicPlanLimiter('api', 60 * 1000);
