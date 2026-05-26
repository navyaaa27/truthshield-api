import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { ApiKeyService } from './apikey.service.js';

const router = Router();

// Apply JWT authentication globally for API Key management
router.use(authenticate);

// GET /api-keys - List org's API keys (no hashes)
router.get('/', async (req: any, res: any, next: any) => {
  try {
    const orgId = req.user.orgId || req.user.organizationId;
    const keys = await ApiKeyService.listApiKeys(orgId);
    res.json({ keys });
  } catch (err) {
    next(err);
  }
});

// POST /api-keys - Create a new API key
router.post('/', authorize('admin'), async (req: any, res: any, next: any) => {
  try {
    const orgId = req.user.orgId || req.user.organizationId;
    const userId = req.user.userId;
    const { name, scopes, allowedIps, expiresAt } = req.body;

    if (!name || !scopes) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'name and scopes are required properties',
      });
    }

    const { apiKey, plainKey } = await ApiKeyService.createApiKey({
      orgId,
      createdBy: userId,
      name,
      scopes,
      allowedIps,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });

    res.status(201).json({
      apiKey,
      plainKey,
      warning: 'Store this key securely. It will not be shown again.',
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api-keys/:id - Revoke an API key
router.delete('/:id', authorize('admin'), async (req: any, res: any, next: any) => {
  try {
    const orgId = req.user.orgId || req.user.organizationId;
    const userId = req.user.userId;
    const keyId = req.params.id;

    await ApiKeyService.revokeApiKey(keyId, orgId, userId);
    res.json({ message: 'API Key revoked successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /api-keys/:id/rotate - Rotate an API key
router.post('/:id/rotate', authorize('admin'), async (req: any, res: any, next: any) => {
  try {
    const orgId = req.user.orgId || req.user.organizationId;
    const userId = req.user.userId;
    const keyId = req.params.id;

    const { apiKey, plainKey } = await ApiKeyService.rotateApiKey(keyId, orgId, userId);
    res.json({
      apiKey,
      plainKey,
      warning: 'Store this key securely. It will not be shown again.',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
