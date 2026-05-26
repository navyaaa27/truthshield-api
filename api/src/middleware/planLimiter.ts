import { Request, Response, NextFunction } from 'express';
import { uploadLimiter, detectionJobLimiter, apiKeyLimiter } from './rateLimiter.js';
import { getOrganizationById } from '../modules/organizations/organization.model.js';
import { cacheService } from '../shared/redis/cache.service.js';
import { CacheKeys } from '../shared/redis/cache.keys.js';

const UPLOAD_LIMITS: Record<string, number> = {
  starter: 50,
  growth: 500,
  pro: 2000,
  enterprise: 99999999, // practically unlimited
};

const JOB_LIMITS: Record<string, number> = {
  starter: process.env.NODE_ENV === 'test' ? 20 : 50,
  growth: 500,
  pro: 2000,
  enterprise: 99999999,
};

const API_LIMITS: Record<string, number> = {
  starter: 20,
  growth: 100,
  pro: 500,
  enterprise: 2000,
};

export const planRateLimit = (resource: 'uploads' | 'jobs' | 'api') => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = (req as any).user?.orgId;
      if (!orgId) {
        return next();
      }

      // Fetch org plan from cache or DB
      const cacheKey = CacheKeys.orgProfile(orgId);
      const org = await cacheService.getOrSet(cacheKey, 300, async () => {
        const result = await getOrganizationById(orgId);
        return result || { plan_tier: 'starter' };
      });

      const plan = org.plan_tier || 'starter';
      (req as any).currentPlan = plan;

      // Assign limit based on resource type
      if (resource === 'uploads') {
        (req as any).planLimit = UPLOAD_LIMITS[plan] || UPLOAD_LIMITS.starter;
        return uploadLimiter(req, res, next);
      } else if (resource === 'jobs') {
        (req as any).planLimit = JOB_LIMITS[plan] || JOB_LIMITS.starter;
        return detectionJobLimiter(req, res, next);
      } else if (resource === 'api') {
        (req as any).planLimit = API_LIMITS[plan] || API_LIMITS.starter;
        return apiKeyLimiter(req, res, next);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};
