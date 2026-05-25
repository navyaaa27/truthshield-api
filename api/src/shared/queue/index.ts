import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

// Parse Redis URL for BullMQ connection options
const redisUrl = new URL(env.REDIS_URL);
const connection: ConnectionOptions = {
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port || '6379', 10),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
};

// Define standard queues
export const mainQueue = new Queue('MainQueue', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: true,
    removeOnFail: 1000, // Keep failed jobs for 1000 items/history check
  },
});

/**
 * Helper to dispatch background tasks easily
 */
export async function dispatchBackgroundJob(name: string, data: any): Promise<Job> {
  logger.info(`Dispatching job to MainQueue: ${name}`);
  return await mainQueue.add(name, data);
}

/**
 * Creates and registers a worker for a queue
 */
export function createQueueWorker(
  queueName: string,
  processor: (job: Job) => Promise<any>,
): Worker {
  const worker = new Worker(queueName, processor, { connection });

  worker.on('active', (job) => {
    logger.info(`Job ${job.id} [${job.name}] has started`);
  });

  worker.on('completed', (job) => {
    logger.info(`Job ${job.id} [${job.name}] completed successfully`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`Job ${job?.id} [${job?.name}] failed with error: ${err.message}`);
  });

  return worker;
}
