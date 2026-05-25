import { Job } from 'bullmq';
import { BaseWorker } from './base.worker.js';
import { logger } from '../../utils/logger.js';
import { query } from '../database/pool.js';
import { AlertService } from '../../modules/alerts/alert.service.js';
import { NotificationService } from '../../modules/alerts/notification.service.js';

export class AlertWorker extends BaseWorker {
  constructor(concurrency = 5) {
    super('alertQueue', concurrency);
    logger.info(`AlertWorker initialized with concurrency limit: ${concurrency}`);
  }

  async process(job: Job): Promise<void> {
    const { jobId, orgId } = job.data;

    if (!jobId || !orgId) {
      throw new Error(`Invalid alert queue job data: ${JSON.stringify(job.data)}`);
    }

    logger.info(`[AlertWorker] Processing alerts for Job: ${jobId}, Org: ${orgId}`);

    // 1. Generate alerts for the completed detection job results
    const alerts = await AlertService.generateAlerts(jobId, orgId);
    
    if (alerts.length === 0) {
      logger.info(`[AlertWorker] No alerts generated for Job: ${jobId} (all module scores under 25)`);
      return;
    }

    // 2. Fetch the organization to get notification channels and preferences
    const orgRes = await query(`SELECT * FROM organizations WHERE id = $1`, [orgId]);
    const org = orgRes.rows[0];

    if (!org) {
      logger.warn(`[AlertWorker] Organization ${orgId} not found, skipping notifications for ${alerts.length} alerts`);
      return;
    }

    // 3. Concurrently send notifications for each alert generated
    for (const alert of alerts) {
      try {
        await NotificationService.sendAlertNotifications(alert, org);
        logger.info(`[AlertWorker] Dispatched notifications successfully for Alert ${alert.id}`);
      } catch (err: any) {
        // Errors in notification do not fail the overall queue job
        logger.error(`[AlertWorker] Failed to dispatch notifications for Alert ${alert.id}: ${err.message}`);
      }
    }
  }
}
