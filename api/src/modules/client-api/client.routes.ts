import { Router, Request, Response, NextFunction } from 'express';
import { authenticateJWTOrApiKey } from '../../middleware/authenticateApiKey.js';
import { JobModel } from '../jobs/job.model.js';
import { dispatchJob } from '../jobs/job.dispatcher.js';
import { S3Service } from '../../shared/storage/s3.service.js';
import { query } from '../../shared/database/pool.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// Secure all client API routes with the combined authentication middleware
router.use(authenticateJWTOrApiKey);

/**
 * POST /v1/analyze
 * Client-facing submission endpoint to create and dispatch detection jobs.
 */
router.post('/v1/analyze', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const { contentType, sourceUrl, detectionModules, webhookUrl, metadata } = req.body;
    const orgId = (req as any).user.orgId;
    const userId = (req as any).user.userId || '00000000-0000-0000-0000-000000000000';

    if (!contentType || !detectionModules || !Array.isArray(detectionModules)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'contentType and detectionModules (array) are required fields',
      });
    }

    // 1. Create base job record
    const job = await JobModel.createJob(orgId, userId, {
      contentType,
      detectionModules,
      sourceUrl,
    });

    // 2. Store webhookUrl and custom client metadata in source_metadata if present
    if (webhookUrl || metadata) {
      const sourceMetadata = {
        webhookUrl,
        clientMetadata: metadata || {},
      };
      await query(
        `UPDATE detection_jobs SET source_metadata = $1 WHERE id = $2`,
        [JSON.stringify(sourceMetadata), job.id]
      );
    }

    // 3. Process dispatching or pre-signed URL generation
    const noUploadNeeded = contentType === 'url' || contentType === 'article';
    if (noUploadNeeded || sourceUrl) {
      // Force sourceUrl dispatching
      if (sourceUrl && !job.source_url) {
        await query(
          `UPDATE detection_jobs SET source_url = $1 WHERE id = $2`,
          [sourceUrl, job.id]
        );
      }
      const reFetched = await JobModel.getJobById(job.id, orgId);
      await dispatchJob(reFetched || job);

      return res.status(201).json({
        jobId: job.id,
        status: 'queued',
        estimatedSeconds: 60,
      });
    } else {
      // Presign S3 URL for file/video/image uploads
      let fileName = `upload_${job.id}`;
      let mimeType = 'application/octet-stream';
      
      if (contentType === 'video') {
        fileName += '.mp4';
        mimeType = 'video/mp4';
      } else if (contentType === 'image') {
        fileName += '.png';
        mimeType = 'image/png';
      } else {
        fileName += '.pdf';
        mimeType = 'application/pdf';
      }

      const presigned = await S3Service.getPresignedUploadUrl({
        orgId,
        jobId: job.id,
        fileName,
        mimeType,
        fileSizeBytes: 10 * 1024 * 1024, // 10MB safe ceiling limit
      });

      await query(
        `UPDATE detection_jobs SET s3_key = $1 WHERE id = $2`,
        [presigned.s3Key, job.id]
      );

      return res.status(201).json({
        jobId: job.id,
        uploadUrl: presigned.uploadUrl,
        uploadExpiry: presigned.expiresAt.toISOString(),
      });
    }
  } catch (err: any) {
    logger.error(`[/v1/analyze] Submission error: ${err.message}`);
    next(err);
  }
});

/**
 * GET /v1/jobs/:id
 * Fetches simplified metrics and verdicts of a specific job.
 */
router.get('/v1/jobs/:id', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const { id } = req.params;
    const orgId = (req as any).user.orgId;

    const job = await JobModel.getJobWithResults(id, orgId);
    if (!job) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Job record not found',
      });
    }

    return res.json({
      jobId: job.id,
      status: job.status,
      contentType: job.content_type,
      detectionModules: job.detection_modules,
      score: (job as any).aggregated_score ?? null,
      verdict: (job as any).aggregated_verdict ?? null,
      riskLevel: (job as any).aggregated_risk_level ?? null,
      createdAt: job.created_at,
      completedAt: job.completed_at || null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/jobs
 * Lists simplified job summaries paginated.
 */
router.get('/v1/jobs', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const orgId = (req as any).user.orgId;
    const status = req.query.status as string | undefined;
    const page = parseInt(req.query.page as string || '1', 10);
    const limit = parseInt(req.query.limit as string || '10', 10);

    const result = await JobModel.getJobsByOrg(orgId, { status, page, limit });

    const simplifiedJobs = result.jobs.map((j) => ({
      jobId: j.id,
      status: j.status,
      contentType: j.content_type,
      score: (j as any).aggregated_score ?? null,
      verdict: (j as any).aggregated_verdict ?? null,
      createdAt: j.created_at,
    }));

    return res.json({
      jobs: simplifiedJobs,
      total: result.total,
      page,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/assets
 * Index a brand asset into PostgreSQL.
 */
router.post('/v1/assets', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const orgId = (req as any).user.orgId;
    const userId = (req as any).user.userId || '00000000-0000-0000-0000-000000000000';
    const { assetName, assetType, s3Key, fileSizeBytes, mimeType } = req.body;

    if (!assetName || !assetType || !s3Key) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'assetName, assetType, and s3Key are required fields',
      });
    }

    const insertRes = await query(
      `INSERT INTO brand_assets (
        org_id, 
        uploaded_by, 
        asset_name, 
        asset_type, 
        s3_key, 
        file_size_bytes, 
        mime_type
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *`,
      [
        orgId,
        userId,
        assetName,
        assetType,
        s3Key,
        fileSizeBytes || null,
        mimeType || null,
      ]
    );

    return res.status(201).json({
      success: true,
      asset: insertRes.rows[0],
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/assets
 * Lists active brand assets for organization.
 */
router.get('/v1/assets', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const orgId = (req as any).user.orgId;

    const resDb = await query(
      `SELECT id, org_id, uploaded_by, asset_name, asset_type, s3_key, file_size_bytes, mime_type, created_at
       FROM brand_assets
       WHERE org_id = $1 AND is_active = true
       ORDER BY created_at DESC`,
      [orgId]
    );

    return res.json({
      assets: resDb.rows,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
