import { redisClient } from './redis.client.js';
import { logger } from '../../utils/logger.js';

/**
 * Application-wide cache service.
 * All methods are failure-safe — Redis outages never crash the application.
 */
export class CacheService {
  /**
   * Retrieves a cached value by key.
   * Returns null on cache miss or Redis failure.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await redisClient.get(key);
      if (value === null) {
        logger.debug(`[Cache] MISS: ${key}`);
        return null;
      }
      logger.debug(`[Cache] HIT: ${key}`);
      return JSON.parse(value) as T;
    } catch (err: any) {
      logger.warn(`[Cache] get() failed for key "${key}": ${err.message}`);
      return null;
    }
  }

  /**
   * Stores a value in cache with a TTL.
   * Silently logs warnings on failure — never throws.
   */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await redisClient.setex(key, ttlSeconds, serialized);
      logger.debug(`[Cache] SET: ${key} (TTL: ${ttlSeconds}s)`);
    } catch (err: any) {
      logger.warn(`[Cache] set() failed for key "${key}": ${err.message}`);
    }
  }

  /**
   * Deletes a single cached key.
   */
  async delete(key: string): Promise<void> {
    try {
      await redisClient.del(key);
      logger.debug(`[Cache] DEL: ${key}`);
    } catch (err: any) {
      logger.warn(`[Cache] delete() failed for key "${key}": ${err.message}`);
    }
  }

  /**
   * Deletes all keys matching a glob pattern.
   * Use sparingly — keys() is O(N) on large datasets.
   * Capped at 1000 keys per call for safety.
   */
  async deletePattern(pattern: string): Promise<void> {
    try {
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        const batch = keys.slice(0, 1000);
        // Strip the keyPrefix ('ts:') since del() auto-prepends it
        const stripped = batch.map((k) => k.replace(/^ts:/, ''));
        await redisClient.del(...stripped);
        logger.debug(`[Cache] DEL_PATTERN: ${pattern} (${batch.length} keys)`);
      }
    } catch (err: any) {
      logger.warn(`[Cache] deletePattern() failed for "${pattern}": ${err.message}`);
    }
  }

  /**
   * Cache-aside pattern: check cache first, fall back to fetchFn on miss.
   * On Redis failure, calls fetchFn directly — always returns a value.
   */
  async getOrSet<T>(key: string, ttlSeconds: number, fetchFn: () => Promise<T>): Promise<T> {
    try {
      const cached = await this.get<T>(key);
      if (cached !== null) {
        return cached;
      }
    } catch {
      // Redis failure — proceed to fetchFn
    }

    const value = await fetchFn();

    // Cache the result in the background — don't await to avoid blocking
    this.set(key, value, ttlSeconds).catch(() => {
      // Already logged inside set()
    });

    return value;
  }

  /**
   * Invalidates all cache entries for a specific organization.
   * Call after any org data mutation.
   */
  async invalidateOrgCache(orgId: string): Promise<void> {
    await this.deletePattern(`ts:org:${orgId}:*`);
    logger.debug(`[Cache] Invalidated all cache for org: ${orgId}`);
  }

  /**
   * Atomically increments a counter and sets TTL if the key is new.
   * Used for rate limiting counters.
   */
  async incrementWithExpiry(key: string, ttlSeconds: number): Promise<number> {
    try {
      const count = await redisClient.incr(key);
      // Set TTL only if this is a new key (count === 1)
      if (count === 1) {
        await redisClient.expire(key, ttlSeconds);
      }
      return count;
    } catch (err: any) {
      logger.warn(`[Cache] incrementWithExpiry() failed for "${key}": ${err.message}`);
      return 0;
    }
  }
}

/** Singleton cache service instance */
export const cacheService = new CacheService();
