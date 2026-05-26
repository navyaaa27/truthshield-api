/* eslint-disable @typescript-eslint/ban-ts-comment */
import request from 'supertest';
import { jest } from '@jest/globals';
import { env } from '../src/config/env.js';

// Mock DB and Redis modules before importing the app
jest.mock('../src/shared/database/index.js', () => ({
  checkDatabaseHealth: (jest.fn() as any).mockResolvedValue({
    writePool: { connected: true, poolSize: 5, idleCount: 3, waitingCount: 0 },
    readPool: { connected: true, poolSize: 5, idleCount: 3, waitingCount: 0 },
    slowQueriesLastHour: 0,
  }),
  query: (jest.fn() as any).mockResolvedValue({ rows: [], rowCount: 0 }),
}));

jest.mock('../src/shared/database/pool.js', () => ({
  query: (jest.fn() as any).mockResolvedValue({ rows: [], rowCount: 0 }),
  writePool: {
    query: (jest.fn() as any).mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 }),
    totalCount: 5, idleCount: 3, waitingCount: 0, on: jest.fn(),
  } as any,
  readPool: {
    query: (jest.fn() as any).mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 }),
    totalCount: 5, idleCount: 3, waitingCount: 0, on: jest.fn(),
  } as any,
  getSlowQueriesLastHourCount: (jest.fn() as any).mockReturnValue(0),
  updatePoolMetrics: jest.fn(),
} as any));

jest.mock('../src/shared/redis/index.js', () => ({
  redis: {
    ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
    quit: jest.fn().mockImplementation(() => Promise.resolve()),
  },
  checkRedisHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
}));

jest.mock('../src/shared/redis/redis.client.js', () => ({
  redisClient: {
    get: jest.fn().mockImplementation(((_key: any) => Promise.resolve(null)) as any),
    setex: jest.fn().mockImplementation(((_key: any, _ttl: any, _val: any) => Promise.resolve('OK')) as any),
    del: jest.fn().mockImplementation(((_key: any) => Promise.resolve(1)) as any),
    keys: jest.fn().mockImplementation((() => Promise.resolve([])) as any),
    incr: jest.fn().mockImplementation((() => Promise.resolve(1)) as any),
    expire: jest.fn().mockImplementation((() => Promise.resolve(1)) as any),
    call: jest.fn().mockImplementation(((command: string, ...args: any[]) => {
      const cmd = command.toLowerCase();
      if (cmd === 'script' && args[0]?.toLowerCase() === 'load') {
        return Promise.resolve('fake_sha_hash');
      }
      if (cmd === 'evalsha' || cmd === 'eval') {
        return Promise.resolve([1, 60]); 
      }
      return Promise.resolve();
    }) as any),
    on: jest.fn(),
  },
  isRedisHealthy: jest.fn().mockImplementation(() => Promise.resolve(true)),
  getRedisLatency: jest.fn().mockImplementation(() => Promise.resolve(1)),
}));

import { app } from '../src/app.js';
import { sanitizeLog } from '../src/utils/logger.js';

describe('TruthShield API Security and Hardening Suite', () => {
  describe('Security Headers Verification', () => {
    it('should present critical security headers on all responses', async () => {
      const response = await request(app).get('/health');

      // 1. X-Frame-Options (Helmet frameguard: deny)
      expect(response.headers['x-frame-options']).toBe('DENY');

      // 2. Content-Security-Policy
      expect(response.headers['content-security-policy']).toBeDefined();

      // 3. Strict-Transport-Security (HSTS)
      expect(response.headers['strict-transport-security']).toBeDefined();
      expect(response.headers['strict-transport-security']).toContain('max-age=31536000');

      // 4. X-Request-ID
      expect(response.headers['x-request-id']).toBeDefined();
    });
  });

  describe('GET /health Diagnostic Endpoint', () => {
    it('should return 200 and valid health parameters when dependencies are online', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.db).toBeDefined();
      expect(response.body.redis).toBeDefined();
      expect(response.body.redis.status).toBe('ok');
    });
  });

  describe('Log Sanitization Security Checks', () => {
    it('should sanitize and strip sensitive attributes correctly', () => {
      const sensitiveObj = {
        email: 'user@truthshield.ai',
        password: 'SuperSecurePassword123!',
        token: 'eyj...',
        mfa_secret: 'some-otp-secret',
        api_key: 'ts_live_key',
        nested: {
          secret: 'nested-secret',
          totpCode: '123456',
        },
      };

      const sanitized = sanitizeLog(sensitiveObj) as any;

      expect(sanitized.email).toBe('user@truthshield.ai');
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.token).toBe('[REDACTED]');
      expect(sanitized.mfa_secret).toBe('[REDACTED]');
      expect(sanitized.api_key).toBe('[REDACTED]');
      expect(sanitized.nested.secret).toBe('[REDACTED]');
      expect(sanitized.nested.totpCode).toBe('[REDACTED]');
    });
  });

  describe('Error Trace Leak Prevention', () => {
    let originalNodeEnv: 'development' | 'production' | 'test';

    beforeAll(() => {
      originalNodeEnv = env.NODE_ENV;
    });

    afterAll(() => {
      env.NODE_ENV = originalNodeEnv;
    });

    it('should hide stack traces and internal details in production environment', async () => {
      // Force production mode
      env.NODE_ENV = 'production';

      const response = await request(app).get('/api/v1/auth/non-existent-route-triggering-404');

      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe('NOT_FOUND');

      // Asserts stack trace is missing completely
      expect(response.body.error.stack).toBeUndefined();
    });
  });
});
