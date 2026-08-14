import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

/**
 * Singleton Redis client with production-grade retry strategy.
 * Prefix all keys with 'ts:' to namespace within shared Redis instances.
 */
const redisClient = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // Required by BullMQ
  keyPrefix: 'ts:',
  retryStrategy(times: number): number | null {
    if (times > 10) {
      logger.error(
        `[RedisClient] Exceeded maximum retry attempts (10). Redis connection unavailable — cache will gracefully miss.`,
      );
      return null; // Stop retrying — do NOT crash
    }
    const delay = Math.min(times * 200, 3000);
    logger.warn(`[RedisClient] Retry attempt ${times}, reconnecting in ${delay}ms...`);
    return delay;
  },
  reconnectOnError: (err: Error) => {
    logger.warn(`[RedisClient] Reconnection triggered: ${err.message}`);
    return true;
  },
});

redisClient.on('connect', () => {
  logger.info('[RedisClient] Redis connected');
});

redisClient.on('error', (err: Error) => {
  logger.error(`[RedisClient] Connection error: ${err.message}`);
  // Do NOT throw — cache miss is acceptable
});

/**
 * Checks Redis health by issuing a PING command.
 * Returns false on any failure — never throws.
 */
export async function isRedisHealthy(): Promise<boolean> {
  try {
    const response = await redisClient.ping();
    return response === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Measures Redis round-trip latency in milliseconds.
 * Returns -1 if Redis is unreachable.
 */
export async function getRedisLatency(): Promise<number> {
  try {
    const start = Date.now();
    await redisClient.ping();
    return Date.now() - start;
  } catch {
    return -1;
  }
}

export { redisClient };
