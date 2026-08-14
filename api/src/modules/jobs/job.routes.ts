import { Router, Request, Response, NextFunction } from 'express';
import { body, query as queryVal } from 'express-validator';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validateRequest } from '../../middleware/validateRequest.js';
import { JobModel } from './job.model.js';
import { dispatchJob } from './job.dispatcher.js';
import { ValidationError, NotFoundError } from '../../middleware/errorHandler.js';
import { cacheService } from '../../shared/redis/cache.service.js';
import { CacheKeys } from '../../shared/redis/cache.keys.js';

import { planRateLimit } from '../../middleware/planLimiter.js';

const router = Router();

/**
 * POST /jobs
 * Creates a new detection job in the workspace.
 */
router.post(
  '/jobs',
  authenticate,
  planRateLimit('jobs'),
  [
    body('contentType')
      .isIn(['video', 'image', 'article', 'url', 'file'])
      .withMessage("contentType must be one of: 'video', 'image', 'article', 'url', 'file'"),
    body('detectionModules')
      .isArray({ min: 1 })
      .withMessage('detectionModules must be a non-empty array')
      .custom((value) => {
        const allowed = ['deepfake', 'fake_news', 'stolen_content', 'metadata_tampering'];
        for (const item of value) {
          if (!allowed.includes(item)) {
            throw new Error(`Unsupported module: ${item}`);
          }
        }
        return true;
      }),
    body('priority')
      .optional()
      .isInt({ min: 1, max: 10 })
      .withMessage('priority must be an integer between 1 and 10'),
    body('sourceUrl').optional().isString().trim(),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { contentType, detectionModules, sourceUrl, priority } = req.body;
      const orgId = (req as any).user.orgId;
      const userId = (req as any).user.userId;

      // 1. Create the pending job record in DB
      const job = await JobModel.createJob(orgId, userId, {
        contentType,
        detectionModules,
        sourceUrl,
        priority,
      });

      // Invalidate organization cache to ensure fresh list fetch
      await cacheService.invalidateOrgCache(orgId);

      // 2. Determine upload requirements
      const noUploadNeeded = contentType === 'url' || contentType === 'article';

      if (noUploadNeeded) {
        // Automatically progress job to the queue
        await dispatchJob(job);

        // Fetch fresh state of job from database
        const updatedJob = await JobModel.getJobById(job.id, orgId);

        res.status(201).json({
          success: true,
          job: updatedJob || job,
          uploadRequired: false,
        });
      } else {
        // Return job with pre-signed upload instructions
        res.status(201).json({
          success: true,
          job,
          uploadRequired: true,
          uploadInstructions: {
            method: 'POST',
            url: '/api/v1/uploads/presign',
            body: {
              fileName: 'string (original asset file name)',
              mimeType: 'string (e.g. image/png)',
              fileSizeBytes: 'number',
              jobId: job.id,
            },
          },
        });
      }
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /jobs
 * Queries and paginates organization-scoped jobs.
 */
router.get(
  '/jobs',
  authenticate,
  [
    queryVal('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
    queryVal('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('limit must be between 1 and 100'),
    queryVal('status')
      .optional()
      .isIn(['pending', 'queued', 'processing', 'completed', 'failed', 'cancelled'])
      .withMessage('Invalid status value'),
    queryVal('contentType')
      .optional()
      .isIn(['video', 'image', 'article', 'url', 'file'])
      .withMessage('Invalid contentType value'),
    validateRequest,
  ],
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = (req as any).user.orgId;
      const status = req.query.status as string | undefined;
      const contentType = req.query.contentType as string | undefined;
      const page = parseInt((req.query.page as string) || '1', 10);
      const limit = parseInt((req.query.limit as string) || '10', 10);

      const cacheKey = CacheKeys.jobsList(orgId, status || 'all', page, limit);

      const response = await cacheService.getOrSet(cacheKey, 30, async () => {
        const result = await JobModel.getJobsByOrg(orgId, {
          status,
          contentType,
          page,
          limit,
        });

        const lightJobs = result.jobs.map((j: any) => ({
          id: j.id,
          org_id: j.org_id,
          content_type: j.content_type,
          detection_modules: j.detection_modules,
          status: j.status,
          priority: j.priority,
          source_url: j.source_url,
          created_at: j.created_at,
          updated_at: j.updated_at,
          queued_at: j.queued_at,
          started_at: j.started_at,
          completed_at: j.completed_at,
          aggregated_score: j.aggregated_score ?? null,
          aggregated_verdict: j.aggregated_verdict ?? null,
          aggregated_risk_level: j.aggregated_risk_level ?? null,
          modules_succeeded: j.modules_succeeded ?? [],
          modules_failed: j.modules_failed ?? [],
          modules_skipped: j.modules_skipped ?? [],
        }));

        return {
          jobs: lightJobs,
          total: result.total,
          page: result.page,
        };
      });

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /jobs/:id
 * Fetches a single job joined with its results.
 */
router.get(
  '/jobs/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const orgId = (req as any).user.orgId;

      const cacheKey = CacheKeys.jobDetail(orgId, id);

      const response = await cacheService.getOrSet(cacheKey, 60, async () => {
        const jobWithResults = await JobModel.getJobWithResults(id, orgId);
        if (!jobWithResults) {
          throw new NotFoundError('Job record not found or tenant partition mismatch');
        }

        const resp: any = { success: true, job: jobWithResults };
        if ((jobWithResults as any).aggregated_score !== undefined) {
          resp.aggregation = {
            aggregated_score: (jobWithResults as any).aggregated_score,
            aggregated_verdict: (jobWithResults as any).aggregated_verdict,
            aggregated_risk_level: (jobWithResults as any).aggregated_risk_level,
            modules_succeeded: (jobWithResults as any).modules_succeeded ?? [],
            modules_failed: (jobWithResults as any).modules_failed ?? [],
            modules_skipped: (jobWithResults as any).modules_skipped ?? [],
          };
        }

        // Don't cache in-flight jobs
        const jobStatus = (jobWithResults as any).status;
        if (jobStatus === 'pending' || jobStatus === 'processing') {
          return { __skipCache: true, ...resp };
        }
        return resp;
      });

      // If __skipCache was set, invalidate immediately so it's not stored
      if ((response as any).__skipCache) {
        await cacheService.delete(cacheKey);
        delete (response as any).__skipCache;
      }

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /jobs/:id/cancel
 * Cancels a pending or queued job.
 */
router.post(
  '/jobs/:id/cancel',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const orgId = (req as any).user.orgId;

      const job = await JobModel.getJobById(id, orgId);
      if (!job) {
        throw new NotFoundError('Job record not found or tenant partition mismatch');
      }

      // Check current state before modifying status
      if (job.status === 'processing' || job.status === 'completed' || job.status === 'failed') {
        throw new ValidationError(`Cannot cancel a job that is already in '${job.status}' state`);
      }

      const updated = await JobModel.updateJobStatus(id, 'cancelled');

      res.status(200).json({ success: true, job: updated });
    } catch (error) {
      next(error);
    }
  },
);

/**
 * DELETE /jobs/:id
 * Soft deletes a job. Requires Analyst or Admin roles.
 */
router.delete(
  '/jobs/:id',
  authenticate,
  authorize('analyst', 'admin', 'super-admin'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const orgId = (req as any).user.orgId;

      const job = await JobModel.getJobById(id, orgId);
      if (!job) {
        throw new NotFoundError('Job record not found or tenant partition mismatch');
      }

      // Soft delete: progress active status to cancelled if not in final terminals
      if (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') {
        await JobModel.updateJobStatus(id, 'cancelled');
      }

      res.status(200).json({ success: true, message: 'Job soft-deleted successfully' });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
