/* eslint-disable @typescript-eslint/ban-ts-comment */
import { jest } from '@jest/globals';

// --- Mock ioredis ---
const mockRedisStore = new Map<string, string>();
let mockRedisHealthy = true;

const mockRedisGet = jest.fn().mockImplementation(((key: any) => {
  if (!mockRedisHealthy) return Promise.reject(new Error('Redis connection refused'));
  const val = mockRedisStore.get(`ts:${key}`);
  return Promise.resolve(val || null);
}) as any);

const mockRedisSetex = jest.fn().mockImplementation(((key: any, _ttl: any, value: any) => {
  if (!mockRedisHealthy) return Promise.reject(new Error('Redis connection refused'));
  mockRedisStore.set(`ts:${key}`, value);
  return Promise.resolve('OK');
}) as any);

const mockRedisDel = jest.fn().mockImplementation(((...args: any[]) => {
  if (!mockRedisHealthy) return Promise.reject(new Error('Redis connection refused'));
  for (const key of args) {
    mockRedisStore.delete(`ts:${key}`);
  }
  return Promise.resolve(args.length);
}) as any);

const mockRedisKeys = jest.fn().mockImplementation(((pattern: any) => {
  if (!mockRedisHealthy) return Promise.reject(new Error('Redis connection refused'));
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
  const matched = Array.from(mockRedisStore.keys()).filter((k) => regex.test(k));
  return Promise.resolve(matched);
}) as any);

const mockRedisIncr = jest.fn().mockImplementation(((key: any) => {
  if (!mockRedisHealthy) return Promise.reject(new Error('Redis connection refused'));
  const prefixed = `ts:${key}`;
  const current = parseInt(mockRedisStore.get(prefixed) || '0', 10);
  const next = current + 1;
  mockRedisStore.set(prefixed, String(next));
  return Promise.resolve(next);
}) as any);

const mockRedisExpire = jest.fn().mockImplementation(() => Promise.resolve(1));

const mockRedisPing = jest.fn().mockImplementation(() => {
  if (!mockRedisHealthy) return Promise.reject(new Error('Redis connection refused'));
  return Promise.resolve('PONG');
});

// Mock the redis.client module
jest.mock('../src/shared/redis/redis.client.js', () => ({
  redisClient: {
    get: mockRedisGet,
    setex: mockRedisSetex,
    del: mockRedisDel,
    keys: mockRedisKeys,
    incr: mockRedisIncr,
    expire: mockRedisExpire,
    ping: mockRedisPing,
    call: jest.fn().mockImplementation(((command: string, ...args: any[]) => {
      if (!mockRedisHealthy) return Promise.reject(new Error('Redis connection refused'));
      const cmd = command.toLowerCase();
      if (cmd === 'script' && args[0]?.toLowerCase() === 'load') {
        return Promise.resolve('fake_sha_hash');
      }
      if (cmd === 'evalsha' || cmd === 'eval') {
        const key =
          args.find(
            (arg) =>
              typeof arg === 'string' && (arg.startsWith('ts:rl:') || arg.startsWith('ts:sd:')),
          ) || 'unknown_key';
        const val = parseInt(mockRedisStore.get(key) || '0', 10) + 1;
        mockRedisStore.set(key, val.toString());
        return Promise.resolve([val, 60]);
      }
      return Promise.resolve();
    }) as any),
    on: jest.fn(),
  },
  isRedisHealthy: jest.fn().mockImplementation(() => {
    return Promise.resolve(mockRedisHealthy);
  }),
  getRedisLatency: jest.fn().mockImplementation(() => {
    return Promise.resolve(mockRedisHealthy ? 2 : -1);
  }),
}));

// Mock the old redis index (used by app.ts health check)
jest.mock('../src/shared/redis/index.js', () => ({
  redis: {
    get: jest.fn().mockImplementation(() => Promise.resolve(null)),
    set: jest.fn().mockImplementation(() => Promise.resolve('OK')),
    del: jest.fn().mockImplementation(() => Promise.resolve(1)),
    ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
  },
  checkRedisHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
}));

// Mock database
jest.mock('../src/shared/database/index.js', () => ({
  checkDatabaseHealth: (jest.fn() as any).mockResolvedValue({
    writePool: { connected: true, poolSize: 5, idleCount: 3, waitingCount: 0 },
    readPool: { connected: true, poolSize: 5, idleCount: 3, waitingCount: 0 },
    slowQueriesLastHour: 0,
  }),
  query: (jest.fn() as any).mockResolvedValue({ rows: [], rowCount: 0 }),
}));

jest.mock(
  '../src/shared/database/pool.js',
  () =>
    ({
      pool: {
        connect: (jest.fn() as any).mockImplementation(() =>
          Promise.resolve({
            query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
            release: jest.fn(),
          }),
        ),
        end: (jest.fn() as any).mockImplementation(() => Promise.resolve()),
      },
      testConnection: (jest.fn() as any).mockImplementation(() => Promise.resolve()),
      query: (jest.fn() as any).mockImplementation(() =>
        Promise.resolve({ rows: [], rowCount: 0 }),
      ),
      writePool: {
        query: (jest.fn() as any).mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 }),
        totalCount: 5,
        idleCount: 3,
        waitingCount: 0,
        on: jest.fn(),
      } as any,
      readPool: {
        query: (jest.fn() as any).mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 }),
        totalCount: 5,
        idleCount: 3,
        waitingCount: 0,
        on: jest.fn(),
      } as any,
      getSlowQueriesLastHourCount: (jest.fn() as any).mockReturnValue(0),
      updatePoolMetrics: jest.fn(),
    }) as any,
);

// Mock BullMQ
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockImplementation(() => Promise.resolve({ id: 'mock' })),
    getJobCounts: jest.fn().mockImplementation(() => Promise.resolve({ waiting: 3 })),
    on: jest.fn(),
  })),
  QueueEvents: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
}));

jest.mock('@bull-board/api/bullMQAdapter', () => ({
  BullMQAdapter: jest.fn().mockImplementation((q: any) => ({ queue: q })),
}));

import { cacheService } from '../src/shared/redis/cache.service.js';
import { CacheKeys } from '../src/shared/redis/cache.keys.js';

describe('Redis Caching Layer Tests', () => {
  beforeEach(() => {
    mockRedisStore.clear();
    mockRedisHealthy = true;
    jest.clearAllMocks();
  });

  // --- CacheService core tests ---

  describe('CacheService.getOrSet()', () => {
    it('returns cached value on second call without calling fetchFn again', async () => {
      const fetchFn = jest.fn().mockImplementation(() => Promise.resolve({ data: 'fresh' }));

      // First call: cache miss → calls fetchFn
      const result1 = await cacheService.getOrSet('test:key1', 60, fetchFn as any);
      expect(result1).toEqual({ data: 'fresh' });
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Second call: cache hit → does NOT call fetchFn
      const result2 = await cacheService.getOrSet('test:key1', 60, fetchFn as any);
      expect(result2).toEqual({ data: 'fresh' });
      expect(fetchFn).toHaveBeenCalledTimes(1); // Still 1
    });

    it('calls fetchFn only once for two consecutive calls', async () => {
      let callCount = 0;
      const fetchFn = jest.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ count: callCount });
      });

      await cacheService.getOrSet('counter:key', 120, fetchFn as any);
      const second = await cacheService.getOrSet('counter:key', 120, fetchFn as any);

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ count: 1 }); // Cached value
    });
  });

  describe('CacheService.get() / set()', () => {
    it('cache miss returns null', async () => {
      const result = await cacheService.get('nonexistent:key');
      expect(result).toBeNull();
    });

    it('set then get returns the stored value', async () => {
      await cacheService.set('manual:key', { hello: 'world' }, 60);
      const result = await cacheService.get<{ hello: string }>('manual:key');
      expect(result).toEqual({ hello: 'world' });
    });
  });

  describe('Redis failure resilience', () => {
    it('get() returns null on Redis failure (no throw)', async () => {
      mockRedisHealthy = false;

      const result = await cacheService.get('any:key');
      expect(result).toBeNull();
    });

    it('set() logs warning on Redis failure (no throw)', async () => {
      mockRedisHealthy = false;

      // Should not throw
      await expect(cacheService.set('any:key', { data: 1 }, 60)).resolves.toBeUndefined();
    });

    it('getOrSet() calls fetchFn directly on Redis failure', async () => {
      mockRedisHealthy = false;

      const fetchFn = jest.fn().mockImplementation(() => Promise.resolve('fallback'));
      const result = await cacheService.getOrSet('fail:key', 60, fetchFn as any);

      expect(result).toBe('fallback');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('CacheService.invalidateOrgCache()', () => {
    it('deletes all org-prefixed keys', async () => {
      // Manually populate store with org-prefixed keys
      mockRedisStore.set('ts:org:org-123:profile', JSON.stringify({ name: 'Acme' }));
      mockRedisStore.set('ts:org:org-123:jobs:all:1:10', JSON.stringify({ jobs: [] }));
      mockRedisStore.set('ts:org:org-123:alert_stats', JSON.stringify({ total: 5 }));
      mockRedisStore.set('ts:org:org-456:profile', JSON.stringify({ name: 'Other' }));

      await cacheService.invalidateOrgCache('org-123');

      // org-123 keys should be gone
      expect(mockRedisStore.has('ts:org:org-123:profile')).toBe(false);
      expect(mockRedisStore.has('ts:org:org-123:jobs:all:1:10')).toBe(false);
      expect(mockRedisStore.has('ts:org:org-123:alert_stats')).toBe(false);

      // org-456 key should still exist
      expect(mockRedisStore.has('ts:org:org-456:profile')).toBe(true);
    });
  });

  describe('CacheService.incrementWithExpiry()', () => {
    it('returns incrementing counts', async () => {
      const count1 = await cacheService.incrementWithExpiry('rl:user1:minute', 60);
      expect(count1).toBe(1);

      const count2 = await cacheService.incrementWithExpiry('rl:user1:minute', 60);
      expect(count2).toBe(2);

      const count3 = await cacheService.incrementWithExpiry('rl:user1:minute', 60);
      expect(count3).toBe(3);
    });

    it('sets expire on first increment only', async () => {
      await cacheService.incrementWithExpiry('rl:new:key', 120);
      expect(mockRedisExpire).toHaveBeenCalledTimes(1);

      await cacheService.incrementWithExpiry('rl:new:key', 120);
      // expire NOT called again since count > 1
      expect(mockRedisExpire).toHaveBeenCalledTimes(1);
    });
  });

  // --- CacheKeys builder tests ---

  describe('CacheKeys builder', () => {
    it('orgProfile returns consistent format', () => {
      expect(CacheKeys.orgProfile('abc-123')).toBe('org:abc-123:profile');
    });

    it('jobsList includes all parameters', () => {
      const key = CacheKeys.jobsList('org-1', 'completed', 2, 25);
      expect(key).toBe('org:org-1:jobs:completed:2:25');
    });

    it('jobDetail returns consistent format', () => {
      expect(CacheKeys.jobDetail('org-1', 'job-xyz')).toBe('org:org-1:job:job-xyz');
    });

    it('alertStats returns consistent format', () => {
      expect(CacheKeys.alertStats('org-1')).toBe('org:org-1:alert_stats');
    });

    it('rateLimit returns consistent format', () => {
      expect(CacheKeys.rateLimit('user-1', 'minute')).toBe('rl:user-1:minute');
    });

    it('tokenBlacklist returns consistent format', () => {
      expect(CacheKeys.tokenBlacklist('jti-abc')).toBe('blacklist:jti-abc');
    });

    it('pHashIndex returns consistent format', () => {
      expect(CacheKeys.pHashIndex('org-1')).toBe('phash_index:org-1');
    });

    it('assetHash returns consistent format', () => {
      expect(CacheKeys.assetHash('org-1/image.jpg')).toBe('hash:org-1/image.jpg');
    });
  });

  // --- Health endpoint test ---

  describe('/health endpoint', () => {
    it('includes Redis latency and queue depth', async () => {
      const request = (await import('supertest')).default;
      const { app } = await import('../src/app.js');

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.redis).toBeDefined();
      expect(res.body.redis.status).toBe('ok');
      expect(typeof res.body.redis.latencyMs).toBe('number');
      expect(res.body.queue).toBeDefined();
      expect(typeof res.body.queue.detectionQueueDepth).toBe('number');
      expect(typeof res.body.queue.alertQueueDepth).toBe('number');
      expect(typeof res.body.uptime).toBe('number');
      expect(res.body.version).toBe('1.0.0');
    });
  });
});
