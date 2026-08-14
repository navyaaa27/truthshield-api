import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { DashboardService } from './dashboard.service.js';
import { cacheService } from '../../shared/redis/cache.service.js';
import { subDays } from 'date-fns';
import { ValidationError } from '../../middleware/errorHandler.js';

const router = Router();

/**
 * Custom Rate Limiter Middleware for Export
 * 10 exports per hour per org.
 */
const exportRateLimiter = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const orgId = (req as any).user.orgId;
    const key = `rl:export:${orgId}:1h`;
    const count = await cacheService.incrementWithExpiry(key, 3600);

    if (count > 10) {
      res.status(429).json({
        statusCode: 429,
        code: 'TOO_MANY_REQUESTS',
        message: 'Rate limit exceeded: 10 exports per hour per organization maximum',
        details: null,
      });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * GET /dashboard/overview
 * Returns DashboardOverview.
 */
router.get(
  '/dashboard/overview',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = (req as any).user.orgId;
      const overview = await DashboardService.getOverview(orgId);
      res.json(overview);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /dashboard/feed
 * Returns paginated ThreatFeedItem[]
 */
router.get(
  '/dashboard/feed',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = (req as any).user.orgId;
      const { riskLevel, module, startDate, endDate, page, limit } = req.query;

      const filters = {
        riskLevel: riskLevel as string | undefined,
        module: module as string | undefined,
        startDate: startDate as string | undefined,
        endDate: endDate as string | undefined,
        page: page ? parseInt(page as string, 10) : 1,
        limit: limit ? parseInt(limit as string, 10) : 20,
      };

      const feed = await DashboardService.getThreatFeed(orgId, filters);
      res.json(feed);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /dashboard/trends
 * Returns TrendDataPoint[]
 */
router.get(
  '/dashboard/trends',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = (req as any).user.orgId;
      const { days } = req.query;

      const parsedDays = days ? parseInt(days as string, 10) : 30;
      const finalDays = Math.max(1, Math.min(365, parsedDays));

      const trends = await DashboardService.getTrendData(orgId, finalDays);
      res.json(trends);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /dashboard/modules
 * Returns ModuleBreakdown[]
 */
router.get(
  '/dashboard/modules',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = (req as any).user.orgId;
      const { days } = req.query;

      const parsedDays = days ? parseInt(days as string, 10) : 30;
      const finalDays = Math.max(1, parsedDays);

      const breakdown = await DashboardService.getModuleBreakdown(orgId, finalDays);
      res.json(breakdown);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /dashboard/export
 * Returns last 30 days of threat feed as JSON.
 * Rate limit: 10 exports per hour per org.
 */
router.get(
  '/dashboard/export',
  authenticate,
  exportRateLimiter,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = (req as any).user.orgId;
      const { format: exportFormat } = req.query;

      if (exportFormat !== 'json') {
        throw new ValidationError('Unsupported export format. Only "json" is currently supported.');
      }

      const startDate = subDays(new Date(), 30).toISOString();
      const feed = await DashboardService.getThreatFeed(orgId, {
        page: 1,
        limit: 100, // Export last 100 items maximum
        startDate,
      });

      res.json(feed.items);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
