import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { AlertService } from './alert.service.js';
import { redis } from '../../shared/redis/index.js';
import { query } from '../../shared/database/pool.js';
import { AlertSeverity } from './alert.types.js';

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

      const result = await AlertService.getAlerts(orgId, filters);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /alerts/stats
 * Aggregates and returns alert statistics cached for 60 seconds in Redis.
 */
router.get(
  '/alerts/stats',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = (req as any).user.orgId;
      const cacheKey = `alert_stats:${orgId}`;

      const cached = await redis.get(cacheKey);
      if (cached) {
        res.json(JSON.parse(cached));
        return;
      }

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
        [orgId]
      );

      const row = statsRes.rows[0];
      const stats = {
        total: row?.total || 0,
        bySeverity: {
          low: row?.low || 0,
          medium: row?.medium || 0,
          high: row?.high || 0,
          critical: row?.critical || 0,
        },
        unread: row?.unread || 0,
      };

      await redis.set(cacheKey, JSON.stringify(stats), 'EX', 60);
      res.json(stats);
    } catch (err) {
      next(err);
    }
  }
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

      // Invalidate the stats cache for this org
      await redis.del(`alert_stats:${orgId}`);

      res.json(alert);
    } catch (err) {
      next(err);
    }
  }
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

      // Invalidate the stats cache for this org
      await redis.del(`alert_stats:${orgId}`);

      res.json(alert);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
