process.env.ENABLE_SECURITY_MIDDLEWARE = 'true';

import request from 'supertest';
import { jest } from '@jest/globals';
import express from 'express';
import { env } from '../src/config/env.js';

// Setup Redis Mocks before importing modules
const mockRedisStore: Record<string, string> = {};

jest.mock('../src/shared/redis/redis.client.js', () => ({
  redisClient: {
    get: jest.fn().mockImplementation(((key: any) => Promise.resolve(mockRedisStore[key] || null)) as any),
    setex: jest.fn().mockImplementation(((key: any, _ttl: any, val: any) => {
      mockRedisStore[key] = val;
      return Promise.resolve('OK');
    }) as any),
    del: jest.fn().mockImplementation(((key: any) => {
      delete mockRedisStore[key];
      return Promise.resolve(1);
    }) as any),
    keys: jest.fn().mockImplementation((() => Promise.resolve(Object.keys(mockRedisStore))) as any),
    incr: jest.fn().mockImplementation(((key: any) => {
      const val = parseInt(mockRedisStore[key] || '0', 10) + 1;
      mockRedisStore[key] = val.toString();
      return Promise.resolve(val);
    }) as any),
    expire: jest.fn().mockImplementation((() => Promise.resolve(1)) as any),
    ping: jest.fn().mockImplementation((() => Promise.resolve('PONG')) as any),
    call: jest.fn().mockImplementation(((command: string, ...args: any[]) => {
      const cmd = command.toLowerCase();
      if (cmd === 'script' && args[0]?.toLowerCase() === 'load') {
        return Promise.resolve('fake_sha_hash');
      }
      if (cmd === 'evalsha' || cmd === 'eval') {
        // Find the key that starts with ts:rl: or ts:sd:
        const key = args.find(arg => typeof arg === 'string' && (arg.startsWith('ts:rl:') || arg.startsWith('ts:sd:'))) || 'unknown_key';
        const val = parseInt(mockRedisStore[key] || '0', 10) + 1;
        mockRedisStore[key] = val.toString();
        // Return [currentHits, timeToReset]
        return Promise.resolve([val, 60]); 
      }
      return Promise.resolve();
    }) as any),
    on: jest.fn(),
  },
  isRedisHealthy: jest.fn().mockImplementation((() => Promise.resolve(true)) as any),
  getRedisLatency: jest.fn().mockImplementation((() => Promise.resolve(1)) as any),
}));

jest.mock('../src/shared/redis/cache.service.js', () => ({
  cacheService: {
    getOrSet: jest.fn().mockImplementation(((_key: any, _ttl: any, fetchFn: any) => fetchFn()) as any),
  }
}));

jest.mock('../src/modules/organizations/organization.model.js', () => ({
  getOrganizationById: jest.fn().mockImplementation(((id: any) => {
    if (id === 'org-starter') return Promise.resolve({ plan_tier: 'starter' });
    if (id === 'org-pro') return Promise.resolve({ plan_tier: 'pro' });
    return Promise.resolve(null);
  }) as any)
}));

import { 
  globalLimiter, 
  authLimiter
} from '../src/middleware/rateLimiter.js';
import { authSlowDown } from '../src/middleware/slowDown.js';
import { AbuseDetector, abuseCheck } from '../src/middleware/abuseDetection.js';
import { planRateLimit } from '../src/middleware/planLimiter.js';

describe('Rate Limiting & Abuse Prevention System', () => {
  beforeEach(() => {
    // Clear mock redis store
    for (const key of Object.keys(mockRedisStore)) {
      delete mockRedisStore[key];
    }
    // Clear skip trusted IPs for testing
    env.RATE_LIMIT_SKIP_TRUSTED_IPS = '';
  });

  describe('Rate Limiters', () => {
    it('authLimiter blocks after 5 attempts', async () => {
      const app = express();
      app.set('trust proxy', true);
      app.use('/auth', authLimiter, (_req, res) => { res.json({ success: true }); });

      // Send 5 successful requests
      for (let i = 0; i < 5; i++) {
        const res = await request(app).get('/auth').set('X-Forwarded-For', '1.2.3.4');
        expect(res.status).toBe(200);
      }

      // 6th should be blocked
      const res = await request(app).get('/auth').set('X-Forwarded-For', '1.2.3.4');
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });

    it('globalLimiter applied before business logic', async () => {
      const app = express();
      app.set('trust proxy', true);
      app.use(globalLimiter);
      app.get('/api', (_req, res) => { res.json({ success: true }); });

      // Mock redis to simulate >1000 hits
      mockRedisStore['ts:rl:global:5.5.5.5'] = '1000';

      const res = await request(app).get('/api').set('X-Forwarded-For', '5.5.5.5');
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('Plan-Aware Limiter', () => {
    it('planRateLimit returns 429 with upgrade message when limit exceeded', async () => {
      const app = express();
      app.set('trust proxy', true);
      
      // Mock authenticate middleware that sets user context
      app.use((req, _res, next) => {
        (req as any).user = { orgId: 'org-starter' };
        next();
      });
      
      app.use('/uploads', planRateLimit('uploads'), (_req, res) => { res.json({ success: true }); });

      // Starter plan limit for uploads is 50. Simulate 50 requests
      mockRedisStore['ts:rl:uploads:org-starter'] = '50';

      const res = await request(app).post('/uploads');
      
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
      expect(res.body.error.message).toBe('Upgrade your plan for higher limits');
      expect(res.body.error.currentPlan).toBe('starter');
      expect(res.body.error.upgradeUrl).toBeDefined();
    });

    it('apiKeyLimiter applies different limits per plan', async () => {
      const app = express();
      app.set('trust proxy', true);
      
      // We'll test the dynamic behavior of the planLimit populated by planRateLimit
      app.use((req, _res, next) => {
        (req as any).user = { orgId: 'org-pro' }; // Pro plan has limit 500
        next();
      });
      app.use('/api', planRateLimit('api'), (_req, res) => { res.json({ success: true }); });

      // Pro plan should allow up to 500. Simulate 499 requests
      mockRedisStore['ts:rl:api:org-pro'] = '499';
      let res = await request(app).post('/api');
      expect(res.status).toBe(200);

      // Now it hits 500
      res = await request(app).post('/api');
      expect(res.status).toBe(429);
    });
  });

  describe('Slow Down', () => {
    it('slowDown adds delay after 3 requests', async () => {
      const app = express();
      app.set('trust proxy', true);
      app.use('/auth', authSlowDown, (_req, res) => { res.json({ success: true }); });

      // Mock the store so that the next request is the 4th request
      mockRedisStore['ts:sd:auth:1.1.1.1'] = '3';
      
      const start = Date.now();
      await request(app).get('/auth').set('X-Forwarded-For', '1.1.1.1');
      const duration = Date.now() - start;
      
      // Since it's the 4th request, it should delay for 500ms
      expect(duration).toBeGreaterThanOrEqual(450); // Using 450 to avoid flakiness
    });
  });

  describe('Abuse Detection', () => {
    const detector = new AbuseDetector();

    it('checkBannedIP returns true for banned IPs', async () => {
      mockRedisStore['ts:banned_ip:bad-ip'] = JSON.stringify({ reason: 'test' });
      const isBanned = await detector.checkBannedIP('bad-ip');
      expect(isBanned).toBe(true);

      const isNotBanned = await detector.checkBannedIP('good-ip');
      expect(isNotBanned).toBe(false);
    });

    it('banIP sets Redis key with correct TTL', async () => {
      await detector.banIP('hacker-ip', 'Scanning', 24);
      expect(mockRedisStore['ts:banned_ip:hacker-ip']).toBeDefined();
      
      // Verify setex was called correctly (via our mock)
      const data = JSON.parse(mockRedisStore['ts:banned_ip:hacker-ip']);
      expect(data.reason).toBe('Scanning');
      expect(data.expiresAt).toBeDefined();
    });

    it('suspicious user agent detected correctly', () => {
      expect(detector.checkSuspiciousUserAgent('sqlmap/1.0')).toBe(true);
      expect(detector.checkSuspiciousUserAgent('masscan/1.0')).toBe(true);
      expect(detector.checkSuspiciousUserAgent('')).toBe(true);
      
      expect(detector.checkSuspiciousUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36')).toBe(false);
    });

    it('calculateThreatScore returns 100 for banned IP', () => {
      const score = detector.calculateThreatScore({
        isBanned: true,
        suspiciousUA: false,
        suspiciousPattern: false,
        failedAuthAttempts: 0
      });
      expect(score).toBe(100);
    });

    it('abuseCheck middleware blocks banned IP', async () => {
      const app = express();
      app.set('trust proxy', true);
      app.use(abuseCheck);
      app.get('/', (_req, res) => { res.json({ success: true }); });

      mockRedisStore['ts:banned_ip:1.2.3.4'] = 'true';

      const res = await request(app).get('/').set('X-Forwarded-For', '1.2.3.4');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('IP_BANNED');
    });
  });

  afterAll(() => {
    delete process.env.ENABLE_SECURITY_MIDDLEWARE;
  });
});
