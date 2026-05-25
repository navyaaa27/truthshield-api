/* eslint-disable @typescript-eslint/ban-ts-comment */
import request from 'supertest';
import { jest } from '@jest/globals';
import { env } from '../src/config/env.js';

// Mock DB and Redis modules before importing the app
jest.mock('../src/shared/database/index.js', () => ({
  checkDatabaseHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
  query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
}));

jest.mock('../src/shared/redis/index.js', () => ({
  redis: {
    ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
    quit: jest.fn().mockImplementation(() => Promise.resolve()),
  },
  checkRedisHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
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
      expect(response.body).toEqual({
        status: 'ok',
        db: 'ok',
        redis: 'ok',
        uptime: expect.any(Number),
      });
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

      const sanitized = sanitizeLog(sensitiveObj);

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
