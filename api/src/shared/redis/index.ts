import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // Required by BullMQ
  reconnectOnError: (err: Error) => {
    logger.warn(`Redis reconnection triggered by error: ${err.message}`);
    return true;
  },
});

redis.on('connect', () => {
  logger.info('Connected to Redis server.');
});

redis.on('error', (err: any) => {
  logger.error(`Redis connection error: ${err.message}`);
});

/**
 * Standard Redis helper utilities
 */
export const cache = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await redis.get(key);
      return value ? JSON.parse(value) : null;
    } catch (err: any) {
      logger.error(`Redis get error for key "${key}": ${err.message}`);
      return null;
    }
  },

  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    try {
      const stringifiedValue = JSON.stringify(value);
      if (ttlSeconds) {
        await redis.set(key, stringifiedValue, 'EX', ttlSeconds);
      } else {
        await redis.set(key, stringifiedValue);
      }
    } catch (err: any) {
      logger.error(`Redis set error for key "${key}": ${err.message}`);
    }
  },

  async del(key: string): Promise<void> {
    try {
      await redis.del(key);
    } catch (err: any) {
      logger.error(`Redis del error for key "${key}": ${err.message}`);
    }
  },
};

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const response = await redis.ping();
    return response === 'PONG';
  } catch (error: any) {
    logger.error(`Redis health check failed: ${error.message}`);
    return false;
  }
}
