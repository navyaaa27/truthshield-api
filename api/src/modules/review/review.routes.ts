import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { ReviewService } from './review.service.js';
import { cacheService } from '../../shared/redis/cache.service.js';
import { ForbiddenError } from '../../middleware/errorHandler.js';

const router = Router();

/**
 * GET /reviews
 * Admin and analyst roles only.
 * Returns review queue with pagination.
 */
router.get(
  '/reviews',
  authenticate,
  authorize('admin', 'analyst'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = (req as any).user.orgId;
      const { status, priority, assignedTo, page, limit } = req.query;

      const filters = {
        status: status as string | undefined,
        priority: priority as string | undefined,
        assignedTo: assignedTo as string | undefined,
        page: page ? parseInt(page as string, 10) : 1,
        limit: limit ? parseInt(limit as string, 10) : 10,
      };

      const result = await ReviewService.getReviewQueue(orgId, filters);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /reviews/stats
 * Admin only.
 * Returns ReviewQueueStats, cached for 60 seconds.
 */
router.get(
  '/reviews/stats',
  authenticate,
  authorize('admin'),
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const cacheKey = 'reviews:stats';
      const stats = await cacheService.getOrSet(cacheKey, 60, async () => {
        return ReviewService.getReviewStats();
      });
      res.json(stats);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /reviews/mine
 * Analyst role only.
 * Returns reviews assigned to the current user.
 */
router.get(
  '/reviews/mine',
  authenticate,
  authorize('analyst'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const analystUserId = (req as any).user.userId;
      const { page, limit } = req.query;

      const pageNum = page ? parseInt(page as string, 10) : 1;
      const limitNum = limit ? parseInt(limit as string, 10) : 10;

      const reviews = await ReviewService.getMyReviews(analystUserId, pageNum, limitNum);
      res.json(reviews);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /reviews/:id
 * Admin or assigned analyst.
 * Returns full review with job + result context.
 */
router.get(
  '/reviews/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const reviewId = req.params.id;
      const review = await ReviewService.getReviewById(reviewId);

      // Org isolation check
      if (review.org_id !== (req as any).user.orgId) {
        throw new ForbiddenError('You do not have permission to access this review');
      }

      // Role authorization
      if ((req as any).user.role !== 'admin' && review.assigned_to !== (req as any).user.userId) {
        throw new ForbiddenError('Only admin or the assigned analyst can view this review');
      }

      res.json(review);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /reviews/:id/assign
 * Admin only (or self-assign for analysts)
 * Body: { analystUserId }
 */
router.post(
  '/reviews/:id/assign',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const reviewId = req.params.id;
      const { analystUserId } = req.body;

      const review = await ReviewService.getReviewById(reviewId);
      // Org isolation check
      if (review.org_id !== (req as any).user.orgId) {
        throw new ForbiddenError('You do not have permission to access this review');
      }

      // Check permissions: Admin only or self-assign for analysts
      if ((req as any).user.role !== 'admin') {
        if ((req as any).user.role !== 'analyst') {
          throw new ForbiddenError('Only analysts and admins can assign reviews');
        }
        if (analystUserId !== (req as any).user.userId) {
          throw new ForbiddenError('Analysts can only assign reviews to themselves');
        }
      }

      const updated = await ReviewService.assignReview(reviewId, analystUserId);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /reviews/:id/start
 * Assigned analyst only.
 */
router.post(
  '/reviews/:id/start',
  authenticate,
  authorize('analyst', 'admin'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const reviewId = req.params.id;
      const review = await ReviewService.getReviewById(reviewId);

      // Org isolation check
      if (review.org_id !== (req as any).user.orgId) {
        throw new ForbiddenError('You do not have permission to access this review');
      }

      if (review.assigned_to !== (req as any).user.userId) {
        throw new ForbiddenError('Only the assigned analyst can start this review');
      }

      const updated = await ReviewService.startReview(reviewId, (req as any).user.userId);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /reviews/:id/submit
 * Assigned analyst only.
 * Body: SubmitReviewDTO
 */
router.post(
  '/reviews/:id/submit',
  authenticate,
  authorize('analyst', 'admin'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const reviewId = req.params.id;
      const dto = req.body;

      const review = await ReviewService.getReviewById(reviewId);

      // Org isolation check
      if (review.org_id !== (req as any).user.orgId) {
        throw new ForbiddenError('You do not have permission to access this review');
      }

      if (review.assigned_to !== (req as any).user.userId) {
        throw new ForbiddenError('Only the assigned analyst can submit this review');
      }

      const updated = await ReviewService.submitReview(reviewId, (req as any).user.userId, dto);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /reviews/:id/escalate
 * Assigned analyst only.
 * Body: { reason }
 */
router.post(
  '/reviews/:id/escalate',
  authenticate,
  authorize('analyst', 'admin'),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const reviewId = req.params.id;
      const { reason } = req.body;

      const review = await ReviewService.getReviewById(reviewId);

      // Org isolation check
      if (review.org_id !== (req as any).user.orgId) {
        throw new ForbiddenError('You do not have permission to access this review');
      }

      if (review.assigned_to !== (req as any).user.userId) {
        throw new ForbiddenError('Only the assigned analyst can escalate this review');
      }

      const updated = await ReviewService.escalateReview(reviewId, (req as any).user.userId, reason);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
