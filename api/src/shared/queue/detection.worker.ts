import { Job } from 'bullmq';
import { BaseWorker } from './base.worker.js';
import { logger } from '../../utils/logger.js';
import { query } from '../database/pool.js';
import { alertQueue } from './queues.js';
import { handleMetadataTampering } from '../../modules/detection/metadata-tampering/metadata.handler.js';
import { handleFakeNews } from '../../modules/detection/fake-news/fakenews.handler.js';
import { handleStolenContent } from '../../modules/detection/stolen-content/stolen.handler.js';
import { handleDeepfake } from '../../modules/detection/deepfake/deepfake.handler.js';
import { aggregateResults, JobAggregation } from '../../modules/jobs/job.aggregator.js';
import { recordDetectionJob, detectionJobsFailedTotal } from '../metrics/metrics.service.js';
import { ReviewService } from '../../modules/review/review.service.js';
import { socketEmitter } from '../websocket/socket.emitter.js';

// --- Types ---

export interface SkippedModule {
  module: string;
  reason: string;
}

export interface FailedModule {
  module: string;
  error: string;
}

export interface ExecutionPlan {
  parallel: string[];
  sequential: string[];
  skipped: SkippedModule[];
}

export interface ModuleRunSummary {
  succeeded: string[];
  failed: FailedModule[];
  skipped: SkippedModule[];
  results: any[];
}

// Module content type compatibility map
const MODULE_CONTENT_TYPES: Record<string, string[]> = {
  metadata_tampering: ['image', 'video', 'file', 'article', 'url'],
  fake_news: ['article', 'url'],
  stolen_content: ['image', 'video'],
  deepfake: ['image', 'video'],
};

// Module handler registry
const MODULE_HANDLERS: Record<string, (job: any) => Promise<any>> = {
  metadata_tampering: handleMetadataTampering,
  fake_news: handleFakeNews,
  stolen_content: handleStolenContent,
  deepfake: handleDeepfake,
};

export class DetectionWorker extends BaseWorker {
  constructor(concurrency = 5) {
    super('detectionQueue', concurrency);
    logger.info(`DetectionWorker initialized with concurrency limit: ${concurrency}`);
  }

  /**
   * Builds an intelligent execution plan that separates parallel-safe modules from sequential ones.
   */
  buildExecutionPlan(detectionModules: string[], contentType: string): ExecutionPlan {
    const parallel: string[] = [];
    const sequential: string[] = [];
    const skipped: SkippedModule[] = [];

    for (const mod of detectionModules) {
      const allowedTypes = MODULE_CONTENT_TYPES[mod];

      // Check content type compatibility
      if (allowedTypes && !allowedTypes.includes(contentType)) {
        skipped.push({ module: mod, reason: 'incompatible_content_type' });
        continue;
      }

      // Deepfake is sequential only for video (frame-by-frame API calls)
      if (mod === 'deepfake' && contentType === 'video') {
        sequential.push(mod);
        continue;
      }

      // All other modules are parallel safe
      parallel.push(mod);
    }

    logger.info(
      `[ExecutionPlan] parallel: [${parallel}], sequential: [${sequential}], skipped: [${skipped.map((s) => s.module)}]`
    );

    return { parallel, sequential, skipped };
  }

  /**
   * Executes the plan: runs parallel modules with Promise.allSettled, then sequential ones.
   */
  async runExecutionPlan(plan: ExecutionPlan, jobRecord: any, planTier = 'starter'): Promise<ModuleRunSummary> {
    const succeeded: string[] = [];
    const failed: FailedModule[] = [];
    const results: any[] = [];

    const orgId = jobRecord.org_id;
    const jobId = jobRecord.id;
    const totalModules = plan.parallel.length + plan.sequential.length;
    const completedModulesList: string[] = [];

    const updateProgress = (completedModule: string) => {
      completedModulesList.push(completedModule);
      const progress = totalModules > 0 ? (completedModulesList.length / totalModules) * 100 : 100;
      socketEmitter.emitJobUpdate(orgId, jobId, {
        status: 'processing',
        progress: Math.round(progress),
        completedModules: [...completedModulesList],
      });
    };

    // --- Run parallel modules ---
    if (plan.parallel.length > 0) {
      const parallelPromises = plan.parallel.map(async (mod) => {
        const start = process.hrtime();
        try {
          const result = await this.runSingleModule(mod, jobRecord);
          const diff = process.hrtime(start);
          const durationMs = Math.round((diff[0] * 1e9 + diff[1]) / 1e6);

          const verdict = result?.verdict || 'none';
          recordDetectionJob(mod, verdict, planTier, jobRecord.content_type || 'image', durationMs);

          updateProgress(mod);
          return { mod, result, status: 'fulfilled' as const };
        } catch (error: any) {
          detectionJobsFailedTotal.inc({ module: mod, error_type: error?.name || 'Error' });
          updateProgress(mod);
          return { mod, error, status: 'rejected' as const };
        }
      });

      const outcomes = await Promise.allSettled(parallelPromises);

      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') {
          const val = outcome.value;
          if (val.status === 'fulfilled') {
            succeeded.push(val.mod);
            results.push(val.result);
            logger.info(`Module '${val.mod}' completed successfully (Score: ${val.result?.score ?? 'N/A'})`);
          } else {
            const errMsg = (val as any).error?.message || 'Unknown error';
            failed.push({ module: val.mod, error: errMsg });
            logger.error(`Module '${val.mod}' failed: ${errMsg}`);
          }
        }
      }
    }

    // --- Run sequential modules one at a time ---
    for (const mod of plan.sequential) {
      const start = process.hrtime();
      try {
        const result = await this.runSingleModule(mod, jobRecord);
        const diff = process.hrtime(start);
        const durationMs = Math.round((diff[0] * 1e9 + diff[1]) / 1e6);

        const verdict = result?.verdict || 'none';
        recordDetectionJob(mod, verdict, planTier, jobRecord.content_type || 'image', durationMs);

        succeeded.push(mod);
        results.push(result);
        logger.info(`Module '${mod}' completed successfully (Score: ${result?.score ?? 'N/A'})`);
      } catch (err: any) {
        detectionJobsFailedTotal.inc({ module: mod, error_type: err?.name || 'Error' });
        failed.push({ module: mod, error: err.message });
        logger.error(`Module '${mod}' failed: ${err.message}`);
      } finally {
        updateProgress(mod);
      }
    }

    return { succeeded, failed, skipped: plan.skipped, results };
  }

  /**
   * Runs a single detection module handler.
   */
  private async runSingleModule(mod: string, jobRecord: any): Promise<any> {
    const handler = MODULE_HANDLERS[mod];
    if (handler) {
      return handler(jobRecord);
    }

    // Dynamic import fallback
    try {
      const handlerModule = await import(`../../modules/detection/handlers/${mod}.js`);
      if (handlerModule && typeof handlerModule.run === 'function') {
        return handlerModule.run(jobRecord.id, jobRecord.org_id);
      }
    } catch {
      // Ignore import failures
    }

    throw new Error(`No handler found for module: ${mod}`);
  }

  /**
   * Main job processing method — builds execution plan, runs modules, aggregates results.
   */
  async process(job: Job): Promise<void> {
    const { jobId, orgId, detectionModules } = job.data;

    logger.info(`Starting detection job ${jobId} processing under Org: ${orgId}`);

    // 1. Update job state to 'processing'
    await this.updateJobStatus(jobId, 'processing');

    socketEmitter.emitJobUpdate(orgId, jobId, {
      status: 'processing',
      progress: 0,
      completedModules: [],
    });

    // 2. Fetch the job record
    const jobRes = await query(`SELECT * FROM detection_jobs WHERE id = $1`, [jobId]);
    const jobRecord = jobRes.rows[0];

    if (!jobRecord) {
      logger.error(`Job not found: ${jobId}`);
      await this.updateJobStatus(jobId, 'failed');
      return;
    }

    const contentType = jobRecord.content_type || '';

    // Fetch the organization's plan tier
    const orgRes = await query(`SELECT plan_tier FROM organizations WHERE id = $1`, [orgId]);
    const planTier = orgRes.rows[0]?.plan_tier || 'starter';

    // 3. Build execution plan
    const plan = this.buildExecutionPlan(detectionModules, contentType);

    // 4. Run execution plan
    const summary = await this.runExecutionPlan(plan, jobRecord, planTier);

    // 5. Aggregate results
    const aggregation = aggregateResults(summary.results);

    // 6. Persist aggregation to the detection_jobs table
    await this.persistAggregation(jobId, aggregation, summary);

    // 6.5 Trigger Human Review Tasks if needed
    for (const result of summary.results) {
      if (ReviewService.shouldTriggerHumanReview(result.score, summary.results)) {
        await ReviewService.createReviewTask(result, jobRecord);
      }
    }

    // 7. Update job state to 'completed'
    await this.updateJobStatus(jobId, 'completed');

    // Increment jobs usage
    import('../../modules/billing/usage.service.js').then((m) => {
      m.UsageService.incrementUsage(orgId, 'jobs').catch(err => {
        logger.error(`[detection.worker] Failed to increment jobs usage: ${err.message}`);
      });
    });

    socketEmitter.emitJobUpdate(orgId, jobId, {
      status: 'completed',
      progress: 100,
      aggregatedScore: aggregation.overallScore,
      aggregatedVerdict: aggregation.overallVerdict,
    });
    socketEmitter.emitDashboardRefresh(orgId);

    // 8. Generate alerts if risk is medium or higher
    if (aggregation.riskLevel !== 'none' && aggregation.riskLevel !== 'low') {
      await alertQueue.add(
        'send-notifications',
        {
          jobId,
          orgId,
          aggregation,
          triggeredModules: summary.succeeded.filter(
            (mod) => (summary.results.find((r: any) => r.module === mod)?.score ?? 0) > 60
          ),
        },
        { jobId }
      );
      logger.info(`Risk level '${aggregation.riskLevel}' — notification queued for Job ${jobId}`);
    }

    // 9. Dispatch job.completed webhook if configured in source_metadata
    try {
      const latestJobRes = await query(`SELECT source_metadata FROM detection_jobs WHERE id = $1`, [jobId]);
      const latestMetadata = latestJobRes.rows[0]?.source_metadata || {};
      if (latestMetadata.webhookUrl) {
        const payload = {
          event: 'job.completed',
          jobId,
          orgId,
          status: 'completed',
          aggregatedScore: aggregation.overallScore,
          aggregatedVerdict: aggregation.overallVerdict,
          riskLevel: aggregation.riskLevel,
          modules: summary.results,
          timestamp: new Date().toISOString(),
        };

        import('../../modules/webhooks/webhook.service.js')
          .then((m) => {
            m.WebhookService.deliverWebhook({
              webhookUrl: latestMetadata.webhookUrl,
              event: 'job.completed',
              payload,
              orgId,
              jobId,
            }).catch((err) => {
              logger.error(`[detection.worker] Webhook delivery failed: ${err.message}`);
            });
          })
          .catch((err) => {
            logger.error(`[detection.worker] Failed to import WebhookService: ${err.message}`);
          });
      }
    } catch (err: any) {
      logger.error(`[detection.worker] Error preparing webhook: ${err.message}`);
    }

    logger.info(
      `Finished processing Job ${jobId}: ` +
        `succeeded=[${summary.succeeded}], failed=[${summary.failed.map((f) => f.module)}], ` +
        `skipped=[${summary.skipped.map((s) => s.module)}], score=${aggregation.overallScore}`
    );
  }

  /**
   * Persists the aggregated scores and module execution summary to the database.
   */
  private async persistAggregation(
    jobId: string,
    aggregation: JobAggregation,
    summary: ModuleRunSummary
  ): Promise<void> {
    try {
      await query(
        `UPDATE detection_jobs SET
          aggregated_score = $1,
          aggregated_verdict = $2,
          aggregated_risk_level = $3,
          modules_succeeded = $4,
          modules_failed = $5,
          modules_skipped = $6,
          source_metadata = COALESCE(source_metadata, '{}'::jsonb) || $7::jsonb
        WHERE id = $8`,
        [
          aggregation.overallScore,
          aggregation.overallVerdict,
          aggregation.riskLevel,
          summary.succeeded,
          summary.failed.map((f) => f.module),
          summary.skipped.map((s) => s.module),
          JSON.stringify({ aggregation }),
          jobId,
        ]
      );
    } catch (err: any) {
      logger.error(`Failed to persist aggregation for job ${jobId}: ${err.message}`);
    }
  }
}
