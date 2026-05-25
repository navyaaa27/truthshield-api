import { Router } from 'express';
import { requireAuth, requireRoles } from '../../middleware/auth.js';
import { validateRequest } from '../../middleware/validation.js';
import {
  OrganizationsController,
  createOrgSchema,
  updateOrgSchema,
} from './organizations.controller.js';

const router = Router();

// All routes here require authenticating first
router.use(requireAuth);

router.get('/', requireRoles(['admin']), OrganizationsController.list);
router.get('/:id', OrganizationsController.getById);

router.post(
  '/',
  requireRoles(['admin']),
  validateRequest({ body: createOrgSchema }),
  OrganizationsController.create,
);
router.put(
  '/:id',
  requireRoles(['admin']),
  validateRequest({ body: updateOrgSchema }),
  OrganizationsController.update,
);
router.delete('/:id', requireRoles(['admin']), OrganizationsController.delete);

export default router;
