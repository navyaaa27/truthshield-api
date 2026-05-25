import { Worker, Job } from 'bullmq';
import { connection } from './queue.config.js';
import { logger } from '../../utils/logger.js';
import { query } from '../database/pool.js';
import { JobModel } from '../../modules/jobs/job.model.js';

export abstract class BaseWorker {
  protected worker!: Worker;

  constructor(queueName: string, concurrency = 5) {
    this.worker = new Worker(
      queueName,
      async (job: Job) => {
        const startTime = Date.now();
        try {
          await this.process(job);
          await this.recordProcessingTime(job.id!, startTime);
        } catch (error: any) {
          await this.handleFailure(job, error);
          throw error; // Re-throw so BullMQ marks attempt as failed
        }
      },
      {
        connection,
        concurrency,
      }
    );

    this.worker.on('failed', (job, err) => {
      logger.error(`Worker job failed ${job?.id}: ${err.message}`);
    });
  }

  abstract process(job: Job): Promise<void>;

  /**
   * Updates job status scoped inside worker context.
   */
  protected async updateJobStatus(
    jobId: string,
    status: string,
    extras?: { errorMessage?: string; s3Key?: string }
  ): Promise<void> {
    await JobModel.updateJobStatus(jobId, status, extras);
  }

  /**
   * Manages job failure and retries. Automatically creates critical notification alerts on final failures.
   */
  protected async handleFailure(job: Job, error: Error): Promise<void> {
    const jobId = job.id!;
    logger.error(`Failed processing job ${jobId} in worker: ${error.message}`, {
      jobId,
      error: error.message,
      stack: error.stack,
    });

    try {
      // 1. Atomically increment retry count
      const res = await query(
        `UPDATE detection_jobs 
         SET retry_count = retry_count + 1, updated_at = NOW() 
         WHERE id = $1 
         RETURNING retry_count, max_retries, org_id`,
        [jobId]
      );

      if (res.rowCount !== null && res.rowCount > 0) {
        const { retry_count, max_retries, org_id } = res.rows[0];

        // 2. If retries exceeded, mark failed and create alert
        if (retry_count >= max_retries) {
          await this.updateJobStatus(jobId, 'failed', { errorMessage: error.message });

          await query(
            `INSERT INTO alerts (org_id, job_id, type, severity, status, message, metadata)
             VALUES ($1, $2, 'job_failure', 'critical', 'open', $3, $4::jsonb)`,
            [
              org_id,
              jobId,
              `Detection job ${jobId} failed after maximum retry threshold (${max_retries} attempts).`,
              JSON.stringify({ error: error.message, stack: error.stack }),
            ]
          );
          logger.info(`Alert generated for failed job ${jobId} under Org: ${org_id}`);
        }
      }
    } catch (err: any) {
      logger.error(`BaseWorker handleFailure failed for job ${jobId}: ${err.message}`);
    }
  }

  /**
   * Computes and saves telemetry metric properties for both detection results and jobs.
   */
  protected async recordProcessingTime(jobId: string, startTime: number): Promise<void> {
    const duration = Date.now() - startTime;
    try {
      // Update detection_results with processing speed metrics
      await query(
        `UPDATE detection_results SET processing_time_ms = $1 WHERE job_id = $2`,
        [duration, jobId]
      );

      // Merge performance metrics into job source metadata
      await query(
        `UPDATE detection_jobs 
         SET source_metadata = source_metadata || $1::jsonb, updated_at = NOW() 
         WHERE id = $2`,
        [JSON.stringify({ processingTimeMs: duration }), jobId]
      );
      
      logger.info(`Processing time recorded for Job ${jobId}: ${duration}ms`);
    } catch (err: any) {
      logger.error(`Failed to record telemetry processing time for job ${jobId}: ${err.message}`);
    }
  }
}
