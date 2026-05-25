import { Queue } from 'bullmq';
import { connection, defaultJobOptions } from './queue.config.js';
import { logger } from '../../utils/logger.js';

export let detectionQueue: Queue;
export let alertQueue: Queue;
export let cleanupQueue: Queue;

// Setup listeners for each queue
const setupQueueListeners = (queue: Queue, name: string) => {
  queue.on('error', (err) => {
    logger.error(`BullMQ Queue '${name}' experienced an error: ${err.message}`);
  });

  queue.on('waiting', async (job) => {
    try {
      const counts = await queue.getJobCounts();
      logger.info(`BullMQ Queue '${name}' job '${job.id}' is waiting. Waiting count: ${counts.waiting}`);
    } catch {}
  });
};

if (process.env.NODE_ENV === 'test' && typeof (Queue as any).mock === 'undefined') {
  const mockQueue = (name: string) => ({
    name,
    add: async (_jobName: string, data: any, opts: any) => ({ id: opts?.jobId || 'mock-id', data, opts }),
    getJobCounts: async () => ({ waiting: 0 }),
    on: () => {},
  });
  detectionQueue = mockQueue('detectionQueue') as any;
  alertQueue = mockQueue('alertQueue') as any;
  cleanupQueue = mockQueue('cleanupQueue') as any;
} else {
  detectionQueue = new Queue('detectionQueue', { connection, defaultJobOptions });
  alertQueue = new Queue('alertQueue', { connection, defaultJobOptions });
  cleanupQueue = new Queue('cleanupQueue', { connection, defaultJobOptions });

  setupQueueListeners(detectionQueue, 'detectionQueue');
  setupQueueListeners(alertQueue, 'alertQueue');
  setupQueueListeners(cleanupQueue, 'cleanupQueue');
}

/**
 * Idempotent helper to dispatch a detection job to the BullMQ system.
 */
export async function addDetectionJob(
  jobId: string,
  orgId: string,
  payload: any,
  priority = 5
): Promise<any> {
  const job = await detectionQueue.add(
    'detection-task',
    { jobId, orgId, ...payload },
    {
      jobId, // Idempotent deduplication identifier
      priority, // Priority support (1-10)
    }
  );
  logger.info(`Job added to detectionQueue: ${jobId} (Org: ${orgId}, Priority: ${priority})`);
  return job;
}
