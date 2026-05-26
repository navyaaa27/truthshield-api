import { Router, Request, Response, NextFunction } from 'express';
import {
  createOrganization,
  getOrganizationById,
  updateOrganization,
  deactivateOrganization,
} from './organization.model.js';
import { AppError } from '../../middleware/error.js';
import { logger } from '../../utils/logger.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { cacheService } from '../../shared/redis/cache.service.js';
import { CacheKeys } from '../../shared/redis/cache.keys.js';

const router = Router();

// POST /organizations - Create a new organization
router.post(
  '/organizations',
  authenticate,
  authorize('admin', 'super-admin'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { name, plan_tier } = req.body;
      if (!name) {
        throw new AppError('Organization name is required', 400);
      }
      const org = await createOrganization(name, plan_tier || 'starter');
      logger.info(`Organization created via REST API: ${org.name} (${org.id})`);
      res.status(201).json(org);
    } catch (error) {
      next(error);
    }
  },
);

// GET /organizations/:id - Fetch organization by ID (cached 5 min)
router.get(
  '/organizations/:id',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const cacheKey = CacheKeys.orgProfile(id);

      const org = await cacheService.getOrSet(cacheKey, 300, async () => {
        const result = await getOrganizationById(id);
        if (!result) {
          throw new AppError('Organization not found', 404);
        }
        return result;
      });

      res.status(200).json(org);
    } catch (error) {
      next(error);
    }
  },
);

// PATCH /organizations/:id - Update organization by ID
router.patch(
  '/organizations/:id',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const org = await updateOrganization(id, updates);

      // Invalidate org profile cache
      await cacheService.delete(CacheKeys.orgProfile(id));

      res.status(200).json(org);
    } catch (error) {
      next(error);
    }
  },
);

// DELETE /organizations/:id - Soft delete (deactivate) organization
router.delete(
  '/organizations/:id',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      await deactivateOrganization(id);

      // Invalidate org profile cache
      await cacheService.delete(CacheKeys.orgProfile(id));

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
);

export default router;
