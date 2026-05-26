import { Job } from 'bullmq';
import { BaseWorker } from './base.worker.js';
import { reportService } from '../../modules/reports/report.service.js';
import { query } from '../database/pool.js';
import { logger } from '../../utils/logger.js';

export class ReportWorker extends BaseWorker {
  constructor(concurrency = 2) {
    super('report-generation', concurrency);
    logger.info(`[ReportWorker] PDF worker active (Concurrency: ${concurrency})`);
  }

  async process(job: Job): Promise<void> {
    const { reportId } = job.data;
    if (!reportId) {
      throw new Error(`Invalid report job data: ${JSON.stringify(job.data)}`);
    }
    logger.info(`[ReportWorker] Commencing report generation: ${reportId}`);
    await reportService.generateReport(reportId);
  }

  protected async recordProcessingTime(jobId: string, startTime: number): Promise<void> {
    const duration = Date.now() - startTime;
    logger.info(`[ReportWorker] Generation completed for Report ID: ${jobId} (Duration: ${duration}ms)`);
  }

  protected async handleFailure(job: Job, error: Error): Promise<void> {
    const { reportId } = job.data;
    if (reportId) {
      logger.error(`[ReportWorker] Generation failure: ${reportId} - Error: ${error.message}`);
      await query(
        `UPDATE reports 
         SET status = 'failed', error_message = $1 
         WHERE id = $2`,
        [error.message, reportId]
      );
    }
  }
}
