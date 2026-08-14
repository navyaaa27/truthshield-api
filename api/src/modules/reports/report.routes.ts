import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { body, query as queryVal, validationResult } from 'express-validator';
import { query } from '../../shared/database/pool.js';
import { reportService } from './report.service.js';
import { ValidationError } from '../../middleware/errorHandler.js';

const router = Router();

/**
 * Helper to handle express-validator validation outcomes.
 */
const validate = (req: Request, _res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMsg = errors
      .array()
      .map((err: any) => `${err.param || err.path || 'field'}: ${err.msg}`)
      .join(', ');
    throw new ValidationError(errorMsg);
  }
  next();
};

/**
 * POST /reports
 * Enqueues a report generation job task.
 */
router.post(
  '/reports',
  authenticate,
  [
    body('reportType')
      .notEmpty()
      .withMessage('reportType is required')
      .isIn(['threat_summary', 'job_detail', 'compliance_audit', 'dmca_bundle'])
      .withMessage('Invalid reportType format'),
    body('dateRange.startDate')
      .notEmpty()
      .withMessage('dateRange.startDate is required')
      .isISO8601()
      .withMessage('dateRange.startDate must be a valid ISO8601 date string'),
    body('dateRange.endDate')
      .notEmpty()
      .withMessage('dateRange.endDate is required')
      .isISO8601()
      .withMessage('dateRange.endDate must be a valid ISO8601 date string'),
    body('format')
      .notEmpty()
      .withMessage('format is required')
      .equals('pdf')
      .withMessage('format must be "pdf"'),
    body('includeScreenshots')
      .optional()
      .isBoolean()
      .withMessage('includeScreenshots must be a boolean value'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = (req as any).user.orgId;
      const userId = (req as any).user.userId;

      const report = await reportService.requestReport({
        orgId,
        requestedBy: userId,
        reportType: req.body.reportType,
        dateRange: req.body.dateRange,
        jobIds: req.body.jobIds,
        includeModules: req.body.includeModules,
        includeScreenshots: !!req.body.includeScreenshots,
        format: 'pdf',
      });

      // Write secure audit trail log
      await query(
        `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id) 
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, userId, 'REPORT_GENERATION_INITIATED', 'reports', report.id],
      );

      res.status(202).json(report);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /reports
 * Listing all enqueued and generated reports for the organization.
 */
router.get(
  '/reports',
  authenticate,
  [
    queryVal('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
    queryVal('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('limit must be an integer between 1 and 100'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orgId = (req as any).user.orgId;
      const page = req.query.page ? parseInt(req.query.page as string) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;

      const data = await reportService.listReports(orgId, page, limit);

      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /reports/:id
 * Retrieve details and temporary secure download links.
 */
router.get(
  '/reports/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const reportId = req.params.id;
      const orgId = (req as any).user.orgId;
      const userId = (req as any).user.userId;

      const report = await reportService.getReport(reportId, orgId);

      // Write secure audit trail log
      await query(
        `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id) 
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, userId, 'REPORT_ACCESSED', 'reports', reportId],
      );

      res.status(200).json(report);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /reports/:id/download
 * Redirects directly to the pre-signed S3 download URL.
 */
router.get(
  '/reports/:id/download',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const reportId = req.params.id;
      const orgId = (req as any).user.orgId;
      const userId = (req as any).user.userId;

      const report = await reportService.getReport(reportId, orgId);

      if (report.status !== 'ready' || !report.downloadUrl) {
        throw new ValidationError('Report is not ready for download.');
      }

      // Write secure audit trail log
      await query(
        `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id) 
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, userId, 'REPORT_DOWNLOADED', 'reports', reportId],
      );

      res.redirect(report.downloadUrl);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * DELETE /reports/:id
 * Permanent deletion of generated PDF audit files.
 */
router.delete(
  '/reports/:id',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const reportId = req.params.id;
      const orgId = (req as any).user.orgId;
      const userId = (req as any).user.userId;

      await reportService.deleteReport(reportId, orgId);

      // Write secure audit trail log
      await query(
        `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id) 
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, userId, 'REPORT_DELETED', 'reports', reportId],
      );

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);

export default router;
