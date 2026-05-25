import { Router } from 'express';
import { requireAuth, requireRoles } from '../../middleware/auth.js';
import { validateRequest } from '../../middleware/validation.js';
import { UsersController, updateProfileSchema } from './users.controller.js';

const router = Router();

// All user operations require JWT authentication
router.use(requireAuth);

router.get('/me', UsersController.getMe);
router.put('/me', validateRequest({ body: updateProfileSchema }), UsersController.updateMe);

// Admin-only operations
router.get('/', requireRoles(['admin']), UsersController.list);
router.put(
  '/:id',
  requireRoles(['admin']),
  validateRequest({ body: updateProfileSchema }),
  UsersController.update,
);

export default router;
