import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

/**
 * Singleton Redis client with production-grade retry strategy.
 * Prefix all keys with 'ts:' to namespace within shared Redis instances.
 */
import { Redis } from 'ioredis';
import { EventEmitter } from 'events';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

class MockRedis extends EventEmitter {
  private store = new Map<string, string>();
  status = 'ready';

  async ping(): Promise<string> {
    return 'PONG';
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ..._args: any[]): Promise<string> {
    this.store.set(key, value);
    return 'OK';
  }

  async setex(key: string, _ttl: number, value: string): Promise<string> {
    this.store.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const deleted = this.store.delete(key);
    return deleted ? 1 : 0;
  }

  async scan(_cursor: number, ..._args: any[]): Promise<[string, string[]]> {
    return ['0', []];
  }

  duplicate(): MockRedis {
    return this;
  }
}

/**
 * Singleton Redis client with production-grade retry strategy.
 * Prefix all keys with 'ts:' to namespace within shared Redis instances.
 */
const redisClient: Redis =
  process.env.MOCK_INFRA === 'true'
    ? ((new MockRedis() as unknown) as Redis)
    : new Redis(env.REDIS_URL, {
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

if (process.env.MOCK_INFRA !== 'true') {
  redisClient.on('connect', () => {
    logger.info('[RedisClient] Redis connected');
  });

  redisClient.on('error', (err: Error) => {
    logger.error(`[RedisClient] Connection error: ${err.message}`);
  });
} else {
  logger.info('[RedisClient] MOCK_INFRA is enabled. In-memory Redis store initialized.');
}

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
