import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { AlertService } from './alert.service.js';
import { query } from '../../shared/database/pool.js';
import { AlertSeverity } from './alert.types.js';
import { cacheService } from '../../shared/redis/cache.service.js';
import { CacheKeys } from '../../shared/redis/cache.keys.js';

const router = Router();

/**
 * GET /alerts
 * Retrieves paginated alerts for the organization, optional filters on severity & acknowledgement status.
 */
router.get(
  '/alerts',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = (req as any).user.orgId;
      const { severity, acknowledged, page, limit } = req.query;

      const filters = {
        severity: severity as AlertSeverity | undefined,
        acknowledged: acknowledged !== undefined ? acknowledged === 'true' : undefined,
        page: page ? parseInt(page as string, 10) : 1,
        limit: limit ? parseInt(limit as string, 10) : 10,
      };

      const cacheKey = CacheKeys.alertsList(
        orgId,
        { severity: filters.severity, acknowledged: filters.acknowledged },
        filters.page,
      );

      const result = await cacheService.getOrSet(cacheKey, 30, async () => {
        return AlertService.getAlerts(orgId, filters);
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /alerts/stats
 * Aggregates and returns alert statistics cached for 60 seconds.
 */
router.get(
  '/alerts/stats',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = (req as any).user.orgId;
      const cacheKey = CacheKeys.alertStats(orgId);

      const stats = await cacheService.getOrSet(cacheKey, 60, async () => {
        const statsRes = await query(
          `SELECT 
             COUNT(*)::int as total,
             COUNT(CASE WHEN severity = 'low' THEN 1 END)::int as low,
             COUNT(CASE WHEN severity = 'medium' THEN 1 END)::int as medium,
             COUNT(CASE WHEN severity = 'high' THEN 1 END)::int as high,
             COUNT(CASE WHEN severity = 'critical' THEN 1 END)::int as critical,
             COUNT(CASE WHEN acknowledged_at IS NULL THEN 1 END)::int as unread
           FROM alerts
           WHERE org_id = $1`,
          [orgId],
        );

        const row = statsRes.rows[0];
        return {
          total: row?.total || 0,
          bySeverity: {
            low: row?.low || 0,
            medium: row?.medium || 0,
            high: row?.high || 0,
            critical: row?.critical || 0,
          },
          unread: row?.unread || 0,
        };
      });

      res.json(stats);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * PATCH /alerts/:id/acknowledge
 * Acknowledges an alert. Any authenticated member of the organization can perform this.
 */
router.patch(
  '/alerts/:id/acknowledge',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const alertId = req.params.id;
      const userId = (req as any).user.userId;
      const orgId = (req as any).user.orgId;

      const alert = await AlertService.acknowledgeAlert(alertId, userId, orgId);

      // Invalidate all alert caches for this org
      await cacheService.invalidateOrgCache(orgId);

      res.json(alert);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * PATCH /alerts/:id/resolve
 * Resolves an alert. Requires analyst or admin role.
 */
router.patch(
  '/alerts/:id/resolve',
  authenticate,
  authorize('analyst', 'admin'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const alertId = req.params.id;
      const userId = (req as any).user.userId;
      const orgId = (req as any).user.orgId;

      const alert = await AlertService.resolveAlert(alertId, userId, orgId);

      // Invalidate all alert caches for this org
      await cacheService.invalidateOrgCache(orgId);

      res.json(alert);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
