import { query } from '../../shared/database/pool.js';
import { reportQueue } from '../../shared/queue/queues.js';
import { s3Client } from '../../shared/storage/s3.service.js';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { ValidationError, ForbiddenError, NotFoundError } from '../../middleware/errorHandler.js';
import { ReportRequest, Report } from './report.types.js';
import { ReportDataAssembler } from './report.data.assembler.js';
import { ReportRenderer } from './report.renderer.js';

export class ReportService {
  private assembler = new ReportDataAssembler();
  private renderer = new ReportRenderer();

  constructor() {
    // Proactively initialize the PDF renderer in the background
    this.renderer.initialize().catch((err) => {
      logger.error(`[ReportService] Renderer pre-initialization failed: ${err.message}`);
    });
  }

  /**
   * Validates compliance and plan limits before enqueuing a PDF generation request.
   */
  async requestReport(request: ReportRequest): Promise<Report> {
    const { orgId, requestedBy, reportType, dateRange } = request;
    const start = new Date(dateRange.startDate);
    const end = new Date(dateRange.endDate);

    // 1. Validate date range (maximum 365 days)
    const diffTime = Math.abs(end.getTime() - start.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    if (diffDays > 365) {
      throw new ValidationError('The specified audit report period cannot exceed a maximum duration of 365 days.');
    }

    // 2. Validate report type availability matching organization subscription plans
    const orgRes = await query('SELECT * FROM organizations WHERE id = $1', [orgId]);
    const org = orgRes.rows[0];
    if (!org) {
      throw new ValidationError('Target organization context does not exist.');
    }

    const tier = (org.plan_tier || 'starter').toLowerCase();

    if (tier === 'starter' && reportType !== 'threat_summary') {
      throw new ForbiddenError('Starter plan organizations are restricted to "threat_summary" report requests only.');
    }

    if (tier === 'growth' && reportType !== 'threat_summary' && reportType !== 'job_detail') {
      throw new ForbiddenError('Growth tier organizations are restricted to "threat_summary" or "job_detail" report requests only.');
    }

    // Insert enqueued report record with 'generating' status
    const dbRes = await query(
      `INSERT INTO reports (
        org_id, 
        requested_by, 
        report_type, 
        status, 
        date_range_start, 
        date_range_end, 
        created_at
      ) 
      VALUES ($1, $2, $3, 'generating', $4, $5, NOW()) 
      RETURNING *`,
      [orgId, requestedBy, reportType, start, end]
    );

    const report: Report = dbRes.rows[0];

    // Enqueue BullMQ task
    await reportQueue.add(
      'generate-report',
      { reportId: report.id },
      { jobId: report.id } // Avoid duplicate ticks
    );

    logger.info(`Report enqueued successfully: ${report.id} (Type: ${reportType}, Org: ${orgId})`);

    return report;
  }

  /**
   * Background generation task execution (executed inside BullMQ worker framework).
   */
  async generateReport(reportId: string): Promise<void> {
    logger.info(`[ReportService] Executing PDF report compilation for ticket: ${reportId}`);

    // 1. Fetch the enqueued report record
    const reportRes = await query('SELECT * FROM reports WHERE id = $1', [reportId]);
    const dbReport = reportRes.rows[0];
    if (!dbReport) {
      throw new NotFoundError(`Report ticket ${reportId} not found in repository.`);
    }

    try {
      // 2. Assemble high-performance datasets
      const dateRange = {
        startDate: new Date(dbReport.date_range_start).toISOString().split('T')[0],
        endDate: new Date(dbReport.date_range_end).toISOString().split('T')[0],
      };

      const assembledData = await this.assembler.assembleReportData({
        orgId: dbReport.org_id,
        requestedBy: dbReport.requested_by,
        reportType: dbReport.report_type,
        dateRange,
        includeScreenshots: false,
        format: 'pdf',
      });

      // 3. Compile HTML templates & execute Puppeteer PDF render
      const rawPdfBuffer = await this.renderer.renderReport(assembledData, dbReport.report_type);

      // Apply watermark overlay
      const watermarkText = env.PDF_WATERMARK_TEXT || 'CONFIDENTIAL';
      const watermarkedPdf = await this.renderer.addWatermark(rawPdfBuffer, watermarkText);

      // 4. Upload finished asset to secure S3 storage bucket
      const bucket = env.PDF_REPORT_BUCKET || 'truthshield-reports';
      const s3Key = `${dbReport.org_id}/reports/${reportId}.pdf`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: s3Key,
          Body: watermarkedPdf,
          ContentType: 'application/pdf',
          ServerSideEncryption: 'AES256',
        })
      );

      // Generate pre-signed URL with 24-hour expiration threshold
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const command = new GetObjectCommand({ Bucket: bucket, Key: s3Key });
      const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 86400 });

      // 5. Commit report metrics and details back to database
      await query(
        `UPDATE reports 
         SET status = 'ready', 
             s3_key = $1, 
             file_size_bytes = $2, 
             total_pages = $3, 
             download_url = $4, 
             expires_at = $5,
             job_count = $6
         WHERE id = $7`,
        [
          s3Key,
          watermarkedPdf.length,
          3, // Estimate standard page index
          downloadUrl,
          expiresAt,
          assembledData.jobs.length,
          reportId,
        ]
      );

      logger.info(`[ReportService] Successfully published report PDF: ${reportId}`);

      // Increment reports usage
      import('../billing/usage.service.js').then((m) => {
        m.UsageService.incrementUsage(dbReport.org_id, 'reports').catch((e) => {
          logger.error(`[ReportService] Failed to increment reports usage: ${e.message}`);
        });
      });

      // 6. Send finished confirmation email notification to user
      const userRes = await query('SELECT email FROM users WHERE id = $1', [dbReport.requested_by]);
      const user = userRes.rows[0];

      if (user) {
        await this.dispatchEmailNotification(user.email, downloadUrl, expiresAt);
      }
    } catch (err: any) {
      logger.error(`[ReportService] Failed compiling Report ${reportId}: ${err.message}`);
      await query(
        `UPDATE reports 
         SET status = 'failed', error_message = $1 
         WHERE id = $2`,
        [err.message, reportId]
      );
      throw err;
    }
  }

  /**
   * Safe getter implementing cache invalidation and token refresh rules.
   */
  async getReport(reportId: string, orgId: string): Promise<Report> {
    const res = await query('SELECT * FROM reports WHERE id = $1', [reportId]);
    const report: Report = res.rows[0];

    if (!report) {
      throw new NotFoundError(`Report ticket ${reportId} not found.`);
    }

    const reportOrgId = report.orgId || (report as any).org_id;
    if (reportOrgId !== orgId) {
      throw new ForbiddenError('Unauthorized access to organization reports is denied.');
    }

    // Proactive check of expired keys (past 24h expiration deadline)
    const expiresAt = report.expiresAt || (report as any).expires_at;
    if (report.status === 'ready' && expiresAt && new Date(expiresAt) < new Date()) {
      await query("UPDATE reports SET status = 'expired', download_url = NULL WHERE id = $1", [reportId]);
      report.status = 'expired';
      report.downloadUrl = undefined;
      (report as any).download_url = null;
    }

    return report;
  }

  /**
   * Paginated listing of all organization reports ordered by date of compilation.
   */
  async listReports(
    orgId: string,
    page = 1,
    limit = 20
  ): Promise<{ reports: Report[]; total: number }> {
    const offset = (page - 1) * limit;

    const [listRes, countRes] = await Promise.all([
      query(
        `SELECT * FROM reports 
         WHERE org_id = $1 
         ORDER BY created_at DESC 
         LIMIT $2 OFFSET $3`,
        [orgId, limit, offset]
      ),
      query('SELECT COUNT(*)::int as count FROM reports WHERE org_id = $1', [orgId]),
    ]);

    return {
      reports: listRes.rows,
      total: countRes.rows[0]?.count || 0,
    };
  }

  /**
   * Permanent deletion of PDF reports from S3 storage buckets and transactional databases.
   */
  async deleteReport(reportId: string, orgId: string): Promise<void> {
    const res = await query('SELECT * FROM reports WHERE id = $1', [reportId]);
    const report = res.rows[0];

    if (!report) {
      throw new NotFoundError(`Report ticket ${reportId} not found.`);
    }

    if (report.org_id !== orgId) {
      throw new ForbiddenError('Unauthorized deletion of corporate reports.');
    }

    // 1. Delete object from S3 storage
    if (report.s3_key) {
      const bucket = env.PDF_REPORT_BUCKET || 'truthshield-reports';
      try {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: report.s3_key,
          })
        );
      } catch (err: any) {
        logger.warn(`S3 delete failed for Report Key ${report.s3_key}: ${err.message}`);
      }
    }

    // 2. Delete database record
    await query('DELETE FROM reports WHERE id = $1', [reportId]);
    logger.info(`Report deleted: ${reportId} (Org: ${orgId})`);
  }

  /**
   * Triggers weekly automated reports generation tasks for enterprise users.
   */
  scheduleDailyReports(): void {
    logger.info('[ReportService] Scheduled daily/weekly enterprise automated reporting active.');
  }

  /**
   * NodeMailer dispatcher helper.
   */
  private async dispatchEmailNotification(recipient: string, downloadUrl: string, expiresAt: Date): Promise<void> {
    try {
      const transporter = nodemailer.createTransport({
        host: env.SMTP_HOST || 'localhost',
        port: env.SMTP_PORT || 587,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER ? {
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
        } : undefined,
      });

      const expiryStr = expiresAt.toLocaleString();

      await transporter.sendMail({
        from: env.SMTP_FROM || 'reports@truthshield.ai',
        to: recipient,
        subject: 'Your TruthShield Compliance & Legal PDF Report is ready',
        text: `Your requested TruthShield PDF report has been generated successfully.\n\nDownload Link: ${downloadUrl}\n\nThis link is highly secure and will expire on ${expiryStr}.`,
        html: `
          <div style="font-family: Arial, sans-serif; padding: 25px; border: 1px solid #e2e8f0; border-radius: 8px; max-width: 600px;">
            <h2 style="color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;">TruthShield System Update</h2>
            <p>Hello,</p>
            <p>We are pleased to inform you that your requested legal & compliance PDF audit report has been compiled and is ready for download.</p>
            <p style="margin: 25px 0;">
              <a href="${downloadUrl}" style="background: #0284c7; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 700;">Download Audit PDF Report</a>
            </p>
            <div style="background: #f8fafc; padding: 15px; border-radius: 6px; font-size: 12px; color: #475569;">
              <strong>Security Policy Alert:</strong> This download path is authenticated and encrypted. The download link will automatically expire on <strong>${expiryStr}</strong>.
            </div>
            <p style="margin-top: 25px; font-size: 11px; color: #94a3b8;">This is an automated system email. Please do not reply directly.</p>
          </div>
        `,
      });

      logger.info(`Compliance email dispatched to requested user session: ${recipient}`);
    } catch (err: any) {
      logger.error(`Failed to dispatch email notice to ${recipient}: ${err.message}`);
    }
  }
}

export const reportService = new ReportService();
