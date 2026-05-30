import { Queue, Worker, Job } from 'bullmq';
import { connection, defaultJobOptions } from './queue.config.js';
import { logger } from '../../utils/logger.js';
import { ReviewService } from '../../modules/review/review.service.js';

export let scheduledQueue: Queue;

if (process.env.NODE_ENV === 'test') {
  scheduledQueue = {
    add: async () => {},
    on: () => {},
  } as any;
} else {
  scheduledQueue = new Queue('scheduledQueue', { connection, defaultJobOptions });
}

export async function setupScheduledJobs(): Promise<void> {
  if (process.env.NODE_ENV === 'test' || process.env.MOCK_INFRA === 'true') return;

  try {
    // Add hourly SLA check job
    await scheduledQueue.add(
      'sla-monitoring',
      {},
      {
        repeat: {
          pattern: '0 * * * *', // Every hour
        },
        jobId: 'sla-monitoring-hourly',
      }
    );
    logger.info('Hourly SLA monitoring job scheduled successfully');
  } catch (err: any) {
    logger.error(`Failed to schedule SLA monitoring job: ${err.message}`);
  }
}

// Scheduled job worker
if (process.env.NODE_ENV !== 'test' && process.env.MOCK_INFRA !== 'true') {
  new Worker(
    'scheduledQueue',
    async (job: Job) => {
      if (job.name === 'sla-monitoring') {
        logger.info('Starting scheduled SLA monitoring job...');
        try {
          const count = await ReviewService.autoResolveExpiredReviews();
          logger.info(`Scheduled SLA monitoring job complete. Auto-resolved ${count} reviews.`);
        } catch (err: any) {
          logger.error(`Scheduled SLA monitoring job failed: ${err.message}`);
        }
      }
    },
    { connection }
  );
}
