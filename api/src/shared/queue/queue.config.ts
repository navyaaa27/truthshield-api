import { ConnectionOptions, DefaultJobOptions } from 'bullmq';
import { env } from '../../config/env.js';

export const connection: ConnectionOptions = {
  // Use connection URL directly
  host: new URL(env.REDIS_URL).hostname,
  port: parseInt(new URL(env.REDIS_URL).port || '6379', 10),
  username: new URL(env.REDIS_URL).username || undefined,
  password: new URL(env.REDIS_URL).password || undefined,
  maxRetriesPerRequest: null, // Required by BullMQ
};

export const defaultJobOptions: DefaultJobOptions = {
  attempts: env.QUEUE_MAX_RETRIES || 3,
  backoff: {
    type: 'exponential',
    delay: env.QUEUE_RETRY_DELAY_MS || 5000,
  },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
};
