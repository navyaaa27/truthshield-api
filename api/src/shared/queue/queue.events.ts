import { QueueEvents } from 'bullmq';
import { connection } from './queue.config.js';
import { logger } from '../../utils/logger.js';
import { JobModel } from '../../modules/jobs/job.model.js';

export const detectionEvents = new QueueEvents('detectionQueue', { connection });

detectionEvents.on('completed', ({ jobId }) => {
  logger.info(`Job completed successfully on detectionQueue: ${jobId}`);
});

detectionEvents.on('failed', ({ jobId, failedReason }) => {
  logger.error(`Job failed on detectionQueue: ${jobId} - Reason: ${failedReason}`);
});

detectionEvents.on('stalled', async ({ jobId }) => {
  logger.warn(
    `Job stalled on detectionQueue: ${jobId}. Automatically setting status to 'failed' in DB`,
  );
  try {
    await JobModel.updateJobStatus(jobId, 'failed', {
      errorMessage: 'Detection job stalled in worker execution queue',
    });
  } catch (err: any) {
    logger.error(`Failed to mark stalled job ${jobId} as failed: ${err.message}`);
  }
});
