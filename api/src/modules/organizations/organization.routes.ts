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

// GET /organizations/:id - Fetch organization by ID
router.get(
  '/organizations/:id',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const org = await getOrganizationById(id);
      if (!org) {
        throw new AppError('Organization not found', 404);
      }
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
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
);

export default router;
