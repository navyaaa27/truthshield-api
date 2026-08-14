/* eslint-disable @typescript-eslint/ban-ts-comment */
import { jest } from '@jest/globals';
import request from 'supertest';

// ──────────────────────────────────────────────
//  1. Mock BullMQ queues / workers
// ──────────────────────────────────────────────
const mockQueueAdd = jest.fn();
const mockGetJobCounts = jest
  .fn()
  .mockImplementation(() => Promise.resolve({ waiting: 0, active: 0, delayed: 0 }));

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((name: any) => ({
    name,
    add: mockQueueAdd,
    getJobCounts: mockGetJobCounts,
    on: jest.fn(),
  })),
  Worker: jest.fn().mockImplementation((name: any, _processor: any) => ({
    name,
    on: jest.fn(),
  })),
}));

// ──────────────────────────────────────────────
//  2. Mock @bull-board
// ──────────────────────────────────────────────
jest.mock('@bull-board/api', () => ({
  createBullBoard: jest.fn().mockReturnValue({}),
}));

jest.mock('@bull-board/api/bullMQAdapter', () => ({
  BullMQAdapter: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@bull-board/express', () => ({
  ExpressAdapter: jest.fn().mockImplementation(() => ({
    setBasePath: jest.fn(),
    getRouter: jest.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  })),
}));

// ──────────────────────────────────────────────
//  3. Mock Redis (both index and client)
// ──────────────────────────────────────────────
jest.mock('../src/shared/redis/index.js', () => ({
  checkRedisHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
  redis: {
    get: jest.fn().mockImplementation(() => Promise.resolve(null)),
    set: jest.fn().mockImplementation(() => Promise.resolve('OK')),
    del: jest.fn().mockImplementation(() => Promise.resolve(1)),
    ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
    quit: jest.fn().mockImplementation(() => Promise.resolve()),
  },
}));

jest.mock('../src/shared/redis/redis.client.js', () => ({
  redisClient: {
    ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
    call: jest.fn().mockImplementation(() => Promise.resolve('ok')),
    get: jest.fn().mockImplementation(() => Promise.resolve(null)),
    set: jest.fn().mockImplementation(() => Promise.resolve('OK')),
    setex: jest.fn().mockImplementation(() => Promise.resolve('OK')),
    del: jest.fn().mockImplementation(() => Promise.resolve(1)),
    keys: jest.fn().mockImplementation(() => Promise.resolve([])),
    incr: jest.fn().mockImplementation(() => Promise.resolve(1)),
    expire: jest.fn().mockImplementation(() => Promise.resolve(1)),
    on: jest.fn(),
  },
  isRedisHealthy: jest.fn().mockImplementation(() => Promise.resolve(true)),
}));

// ──────────────────────────────────────────────
//  4. Mock Database (index + pool)
// ──────────────────────────────────────────────
jest.mock('../src/shared/database/index.js', () => ({
  checkDatabaseHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
  query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
}));

jest.mock('../src/shared/database/pool.js', () => ({
  pool: {
    totalCount: 10,
    idleCount: 5,
    connect: jest.fn().mockImplementation(() =>
      Promise.resolve({
        query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
        release: jest.fn(),
      }),
    ),
    end: jest.fn().mockImplementation(() => Promise.resolve()),
  },
  query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
}));

// ──────────────────────────────────────────────
//  5. Mock on-finished for requestLogger testing
// ──────────────────────────────────────────────
const mockOnFinished = jest.fn();
jest.mock('on-finished', () => mockOnFinished);

// ──────────────────────────────────────────────
//  6. Import units-under-test after all mocks
// ──────────────────────────────────────────────
import { sanitizeForLog, logger } from '../src/utils/logger.js';
import { requestLogger } from '../src/middleware/requestLogger.js';
import {
  httpRequestsTotal,
  detectionJobDurationMs,
  redisConnected,
} from '../src/shared/metrics/metrics.service.js';
import { queueMonitor } from '../src/shared/metrics/queue.monitor.js';
import app from '../src/app.js';

// ══════════════════════════════════════════════
//  Test Suites
// ══════════════════════════════════════════════
describe('Production-Grade Observability Stack Tests', () => {
  let warnSpy: any;
  let infoSpy: any;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mock implementations after clearAllMocks
    (mockGetJobCounts as any).mockImplementation(() =>
      Promise.resolve({ waiting: 0, active: 0, delayed: 0 }),
    );
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  // ────────────────────────────────────────────
  //  A. Log Sanitization Tests
  // ────────────────────────────────────────────
  describe('SanitizeForLog', () => {
    it('redacts top-level password fields', () => {
      const payload = {
        username: 'admin',
        password: 'supersecretpassword123',
        nested: { passwordHash: 'hashed-pass-1234' },
      };
      const sanitized = sanitizeForLog(payload) as any;
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.nested.passwordHash).toBe('[REDACTED]');
      expect(sanitized.username).toBe('admin');
    });

    it('redacts nested token and API key fields', () => {
      const payload = {
        meta: {
          accessToken: 'jwt-access-token-string',
          refreshToken: 'jwt-refresh-token-string',
          apiKey: 'sk-test-key',
        },
        publicField: 'hello',
      };
      const sanitized = sanitizeForLog(payload) as any;
      expect(sanitized.meta.accessToken).toBe('[REDACTED]');
      expect(sanitized.meta.refreshToken).toBe('[REDACTED]');
      expect(sanitized.meta.apiKey).toBe('[REDACTED]');
      expect(sanitized.publicField).toBe('hello');
    });

    it('handles circular references cleanly without throwing', () => {
      const obj: any = { name: 'circular-test' };
      obj.self = obj;

      expect(() => {
        const result = sanitizeForLog(obj) as any;
        expect(result.name).toBe('circular-test');
        expect(result.self).toBe('[Circular]');
      }).not.toThrow();
    });

    it('passes through safe primitive values unchanged', () => {
      expect(sanitizeForLog('a string')).toBe('a string');
      expect(sanitizeForLog(42)).toBe(42);
      expect(sanitizeForLog(null)).toBeNull();
    });
  });

  // ────────────────────────────────────────────
  //  B. Request Logger Middleware Tests
  // ────────────────────────────────────────────
  describe('RequestLogger', () => {
    it('calls next() and registers an on-finished callback', () => {
      const mockReq = {
        method: 'GET',
        url: '/test',
        originalUrl: '/test',
        ip: '127.0.0.1',
        headers: { 'user-agent': 'Jest' },
        socket: {},
      } as any;

      const mockRes = {
        statusCode: 200,
        getHeader: () => '0',
      } as any;

      const mockNext = jest.fn();

      requestLogger(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      // on-finished should have been invoked (registered listener)
      expect(mockOnFinished).toHaveBeenCalled();
    });

    it('logs at correct severity based on response status', () => {
      const mockReq = {
        method: 'POST',
        url: '/api/v1/auth',
        originalUrl: '/api/v1/auth',
        ip: '127.0.0.1',
        headers: {},
        socket: {},
      } as any;

      const mockRes = { statusCode: 200, getHeader: () => '100' } as any;
      const mockNext = jest.fn();

      requestLogger(mockReq, mockRes, mockNext);
      const finishCallback = mockOnFinished.mock.calls[0][1] as any;

      // 2xx → info
      const infoLogSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
      finishCallback(null, mockRes);
      expect(infoLogSpy).toHaveBeenCalled();
      infoLogSpy.mockRestore();

      // 4xx → warn
      const warnLogSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      mockRes.statusCode = 400;
      finishCallback(null, mockRes);
      expect(warnLogSpy).toHaveBeenCalled();
      warnLogSpy.mockRestore();

      // 5xx → error
      const errorLogSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      mockRes.statusCode = 503;
      finishCallback(null, mockRes);
      expect(errorLogSpy).toHaveBeenCalled();
      errorLogSpy.mockRestore();
    });

    it('skips logging for GET /health requests', () => {
      const mockReq = {
        method: 'GET',
        url: '/health',
        originalUrl: '/health',
        ip: '127.0.0.1',
        headers: {},
        socket: {},
      } as any;

      const mockRes = { statusCode: 200, getHeader: () => '0' } as any;
      const mockNext = jest.fn();

      const priorCallCount = mockOnFinished.mock.calls.length;
      requestLogger(mockReq, mockRes, mockNext);
      // on-finished should NOT be registered for health checks
      expect(mockOnFinished.mock.calls.length).toBe(priorCallCount);
      expect(mockNext).toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────
  //  C. Prometheus Metrics Tests
  // ────────────────────────────────────────────
  describe('Prometheus Metrics', () => {
    it('http_requests_total counter can be incremented and read back', async () => {
      const before = await httpRequestsTotal.get();
      const beforeCount = before.values.reduce((s, v) => s + v.value, 0);

      // Directly increment the counter (simulating what metricsMiddleware does on-finished)
      httpRequestsTotal.inc({ method: 'GET', route: '/health', status_code: '200' });

      const after = await httpRequestsTotal.get();
      const afterCount = after.values.reduce((s, v) => s + v.value, 0);
      expect(afterCount).toBeGreaterThan(beforeCount);
    });

    it('metricsMiddleware registers an on-finished callback per request', async () => {
      const priorCallCount = mockOnFinished.mock.calls.length;
      // Send a real request — middleware registers on-finished for every non-/metrics route
      await request(app).get('/health');
      // At least one new on-finished registration from the metrics middleware
      expect(mockOnFinished.mock.calls.length).toBeGreaterThan(priorCallCount);
    });

    it('detection_job_duration_ms histogram observes values', async () => {
      const before = await detectionJobDurationMs.get();
      const beforeTotal = before.values.reduce((s, v) => s + v.value, 0);

      detectionJobDurationMs.observe({ module: 'deepfake', content_type: 'video' }, 450);

      const after = await detectionJobDurationMs.get();
      const afterTotal = after.values.reduce((s, v) => s + v.value, 0);
      expect(afterTotal).toBeGreaterThan(beforeTotal);
    });

    it('redis_connected gauge reflects healthy status', async () => {
      redisConnected.set(0);
      await queueMonitor.pollRedis();
      const val = await redisConnected.get();
      expect(val.values[0].value).toBe(1);
    });
  });

  // ────────────────────────────────────────────
  //  D. Queue Monitor Backpressure Tests
  // ────────────────────────────────────────────
  describe('Queue Monitor Backpressure Alarms', () => {
    it('emits warn log when queue depth exceeds 1000', async () => {
      mockGetJobCounts.mockImplementationOnce((() =>
        Promise.resolve({ waiting: 1200, active: 10, delayed: 0 })) as any);

      await queueMonitor.pollQueues();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('WARNING: Backpressure detected! Queue depth is 1200.'),
      );
    });

    it('emits critical error log when queue depth exceeds 5000', async () => {
      // Both queues return large depth (1st call = detectionQueue, 2nd = alertQueue)
      mockGetJobCounts.mockImplementation((() =>
        Promise.resolve({ waiting: 2600, active: 5, delayed: 0 })) as any);

      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      await queueMonitor.pollQueues();

      // Combined: detectionQueue 2600 wait + alertQueue 2600 wait = 5200 total
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('CRITICAL: High Backpressure detected!'),
      );
      errorSpy.mockRestore();
    });

    it('does not emit alarm when queue depth is below threshold', async () => {
      mockGetJobCounts.mockImplementation((() =>
        Promise.resolve({ waiting: 5, active: 1, delayed: 0 })) as any);

      await queueMonitor.pollQueues();

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────
  //  E. Metrics Endpoint Auth Tests
  // ────────────────────────────────────────────
  describe('Secure /metrics Endpoint', () => {
    it('returns 401 when metrics-secret header is missing', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
      expect(res.text).toContain('Unauthorized');
    });

    it('returns 401 when metrics-secret header is wrong', async () => {
      const res = await request(app).get('/metrics').set('metrics-secret', 'wrong-secret');
      expect(res.status).toBe(401);
    });

    it('returns Prometheus text format with valid metrics-secret header', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('metrics-secret', 'super-secret-metrics-key');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('http_requests_total');
      expect(res.text).toContain('detection_job_duration_ms');
      expect(res.text).toContain('redis_connected');
    });
  });
});
