import { Router, Request, Response, NextFunction } from 'express';
import { S3Service, verifyOrgScope } from '../../shared/storage/s3.service.js';
import { authenticate } from '../../middleware/authenticate.js';
import { query } from '../../shared/database/pool.js';
import { ValidationError, AppError, ForbiddenError } from '../../middleware/errorHandler.js';
import { AssetIndexer } from '../jobs/asset.indexer.js';
import { UsageService } from '../billing/usage.service.js';

import { planRateLimit } from '../../middleware/planLimiter.js';

const router = Router();

/**
 * POST /uploads/presign
 * Generates an AWS S3 pre-signed PUT URL.
 */
router.post(
  '/uploads/presign',
  authenticate,
  planRateLimit('uploads'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { fileName, mimeType, fileSizeBytes, jobId } = req.body;
      const orgId = (req as any).user.orgId;
      const userId = (req as any).user.userId;

      // Validate inputs
      if (!fileName || typeof fileName !== 'string') {
        throw new ValidationError('File name must be a valid string');
      }
      if (!mimeType || typeof mimeType !== 'string') {
        throw new ValidationError('MIME type must be a valid string');
      }
      if (!fileSizeBytes || typeof fileSizeBytes !== 'number' || fileSizeBytes <= 0) {
        throw new ValidationError('File size must be a positive integer');
      }
      if (!jobId || typeof jobId !== 'string') {
        throw new ValidationError('Job ID must be a valid UUID');
      }

      // Enforce billing and subscription limits
      const checkLimit = await UsageService.checkUsageLimit(orgId, 'uploads');
      if (!checkLimit.allowed) {
        throw new AppError('Upload limit exceeded. Please upgrade your plan.', 403, 'LIMIT_EXCEEDED');
      }

      // Enforce multi-tenant access check: verify jobId belongs to orgId!
      const jobRes = await query(
        `SELECT * FROM detection_jobs WHERE id = $1 AND org_id = $2`,
        [jobId, orgId]
      );
      if (jobRes.rowCount === 0) {
        throw new ForbiddenError('Access to job outside organization context is denied');
      }

      // Generate pre-signed URL
      const data = await S3Service.getPresignedUploadUrl({
        orgId,
        jobId,
        fileName,
        mimeType,
        fileSizeBytes,
      });

      // Write transaction-independent audit trail log
      await query(
        `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, userId, 'ASSET_UPLOAD_INITIATED', 'detection_jobs', jobId]
      );

      // Increment uploads usage
      await UsageService.incrementUsage(orgId, 'uploads');

      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /uploads/confirm
 * Confirms the S3 upload completed and persists the file location.
 */
router.post(
  '/uploads/confirm',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { s3Key, jobId } = req.body;
      const orgId = (req as any).user.orgId;
      const userId = (req as any).user.userId;

      if (!s3Key || typeof s3Key !== 'string') {
        throw new ValidationError('S3 Key must be a valid string');
      }
      if (!jobId || typeof jobId !== 'string') {
        throw new ValidationError('Job ID must be a valid UUID');
      }

      // Enforce multi-tenant access check
      verifyOrgScope(s3Key, orgId);

      // Verify file presence on AWS S3
      const check = await S3Service.confirmUpload(s3Key);
      if (!check.exists) {
        res.status(200).json({ confirmed: false, message: 'Asset is not verified on storage client' });
        return;
      }

      // Update detection_jobs record atomically (scoped securely under organization partitions)
      const metadataPatch = JSON.stringify({
        mimeType: check.actualMimeType,
        fileSizeBytes: check.fileSizeBytes,
        confirmedAt: new Date().toISOString(),
      });

      const updateRes = await query(
        `UPDATE detection_jobs 
         SET s3_key = $1, source_metadata = source_metadata || $2::jsonb, updated_at = NOW() 
         WHERE id = $3 AND org_id = $4
         RETURNING id`,
        [s3Key, metadataPatch, jobId, orgId]
      );

      if (updateRes.rowCount === 0) {
        throw new AppError('Job record not found or tenant partition mismatch', 404, 'NOT_FOUND');
      }

      // Record successful confirm event to audit_logs
      await query(
        `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, userId, 'ASSET_UPLOAD_COMPLETED', 'detection_jobs', jobId]
      );

      res.status(200).json({
        confirmed: true,
        mimeType: check.actualMimeType,
        fileSizeBytes: check.fileSizeBytes,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /assets
 * Indexes a confirmed upload as a brand asset.
 */
router.post(
  '/assets',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { s3Key, assetName, assetType } = req.body;
      const orgId = (req as any).user.orgId;
      const userId = (req as any).user.userId;

      if (!s3Key || typeof s3Key !== 'string') {
        throw new ValidationError('S3 Key must be a valid string');
      }
      if (!assetName || typeof assetName !== 'string') {
        throw new ValidationError('Asset Name must be a valid string');
      }
      if (!assetType || typeof assetType !== 'string') {
        throw new ValidationError('Asset Type must be a valid string');
      }

      const indexer = new AssetIndexer();
      const asset = await indexer.indexUploadedAsset(orgId, userId, s3Key, assetName, assetType);

      res.status(201).json(asset);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
