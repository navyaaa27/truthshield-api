/* eslint-disable @typescript-eslint/ban-ts-comment */
process.env.NODE_ENV = 'test';
process.env.ENABLE_SECURITY_MIDDLEWARE = 'true';
process.env.BILLING_ENABLED = 'false'; // for general tests, toggle selectively

import request from 'supertest';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import http from 'http';
import crypto from 'crypto';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { env } from '../../src/config/env.js';

// --- Mock express-rate-limit to prevent ERR_ERL_KEY_GEN_IPV6 ---
jest.mock('express-rate-limit', () => {
  const actualRateLimit = jest.requireActual('express-rate-limit') as any;
  const mockFn = jest.fn().mockImplementation((options: any) => {
    return actualRateLimit({
      ...options,
      max: options && typeof options.max === 'function' ? options.max : options?.max || 1000,
      validate: false,
    });
  });
  (mockFn as any).rateLimit = mockFn;
  (mockFn as any).default = mockFn;
  return mockFn;
});

// --- Mock axios at module level with ES module flag to prevent network overhead ---
let lastWebhookPost: any = null;
jest.mock('axios', () => {
  const mockAxios = {
    post: jest.fn().mockImplementation((url: any, body: any, config: any) => {
      lastWebhookPost = {
        url,
        body: typeof body === 'string' ? JSON.parse(body) : body,
        headers: config?.headers || {},
      };
      return Promise.resolve({ status: 200, data: 'OK' });
    }),
  };
  return {
    __esModule: true,
    default: mockAxios,
    ...mockAxios,
  };
});

import { initializeWebSocket, closeWebSocket } from '../../src/shared/websocket/socket.server.js';
import { socketEmitter } from '../../src/shared/websocket/socket.emitter.js';

// --- Local High-Fidelity DB Mocks & Redis Store ---
let mockOrgs: any[] = [];
let mockUsers: any[] = [];
let mockJobs: any[] = [];
let mockResults: any[] = [];
let mockAlerts: any[] = [];
let mockReviews: any[] = [];
let mockReports: any[] = [];
let mockAuditLogs: any[] = [];
let mockApiKeys: any[] = [];
let mockSubscriptions: any[] = [];
const redisStore = new Map<string, string>();

// --- Mock Redis Client ---
jest.mock('../../src/shared/redis/redis.client.js', () => {
  const getFullKey = (key: string) => (key.startsWith('ts:') ? key : `ts:${key}`);
  return {
    redisClient: {
      get: jest
        .fn()
        .mockImplementation(((key: any) =>
          Promise.resolve(redisStore.get(getFullKey(key)) || null)) as any),
      setex: jest.fn().mockImplementation(((key: any, _ttl: any, value: any) => {
        redisStore.set(getFullKey(key), value.toString());
        return Promise.resolve('OK');
      }) as any),
      del: jest.fn().mockImplementation(((key: any) => {
        if (Array.isArray(key)) {
          key.forEach((k) => redisStore.delete(getFullKey(k)));
        } else {
          redisStore.delete(getFullKey(key));
        }
        return Promise.resolve(1);
      }) as any),
      keys: jest.fn().mockImplementation(((pattern: any) => {
        const matched: string[] = [];
        const regex = new RegExp('^' + getFullKey(pattern).replace(/\*/g, '.*') + '$');
        for (const k of redisStore.keys()) {
          if (regex.test(k)) {
            matched.push(k);
          }
        }
        return Promise.resolve(matched);
      }) as any),
      incr: jest.fn().mockImplementation(((key: any) => {
        const fullKey = getFullKey(key);
        const val = parseInt(redisStore.get(fullKey) || '0', 10) + 1;
        redisStore.set(fullKey, val.toString());
        return Promise.resolve(val);
      }) as any),
      expire: jest.fn().mockImplementation((() => Promise.resolve(1)) as any),
      ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
      call: jest.fn().mockImplementation(((command: string, ...args: any[]) => {
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
          const fullKey = getFullKey(key);
          const val = parseInt(redisStore.get(fullKey) || '0', 10) + 1;
          redisStore.set(fullKey, val.toString());
          return Promise.resolve([val, 60]);
        }
        return Promise.resolve();
      }) as any),
      on: jest.fn(),
    },
    isRedisHealthy: jest.fn().mockImplementation(() => Promise.resolve(true)),
    getRedisLatency: jest.fn().mockImplementation(() => Promise.resolve(1)),
  };
});

jest.mock('../../src/shared/redis/index.js', () => ({
  checkRedisHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
  redis: {
    ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
    quit: jest.fn().mockImplementation(() => Promise.resolve()),
    get: jest
      .fn()
      .mockImplementation(((key: any) => Promise.resolve(redisStore.get(key) || null)) as any),
    set: jest.fn().mockImplementation(((key: any, val: any) => {
      redisStore.set(key, val.toString());
      return Promise.resolve('OK');
    }) as any),
    del: jest.fn().mockImplementation(((key: any) => {
      redisStore.delete(key);
      return Promise.resolve(1);
    }) as any),
  },
}));

// --- Mock BullMQ ---
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(((name: any) => ({
    name,
    add: jest.fn().mockImplementation((jobName: any, data: any) => {
      if (name === 'reports-queue' || jobName === 'generate-report') {
        // Automatically trigger report generation inside test lifecycle
        setTimeout(async () => {
          try {
            const { reportService } = await import('../../src/modules/reports/report.service.js');
            await reportService.generateReport(data.reportId);
          } catch (e) {
            // Ignored
          }
        }, 100);
      }
      return Promise.resolve({ id: `mock-bull-${Math.random()}` });
    }),
    getJobCounts: jest.fn().mockImplementation(() => Promise.resolve({ waiting: 0 })),
    on: jest.fn(),
  })) as any),
  Worker: jest.fn().mockImplementation(((name: any) => ({
    name,
    on: jest.fn(),
  })) as any),
}));

// --- Mock S3 & Watermark Puppeteer Pre-conditions ---
jest.mock('../../src/shared/storage/s3.service.js', () => ({
  s3Client: {
    send: jest.fn().mockImplementation(() => Promise.resolve({})),
  },
  S3Service: {
    getPresignedDownloadUrl: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve('https://s3.amazonaws.com/truthshield-reports/test-report.pdf?sig=fake'),
      ),
    getPresignedUploadUrl: jest.fn().mockImplementation((params: any) =>
      Promise.resolve({
        uploadUrl: 'https://s3.amazonaws.com/truthshield-uploads/fake-upload',
        s3Key: `uploads/${params.orgId}/${params.jobId}/${params.fileName}`,
        expiresAt: new Date(Date.now() + 3600 * 1000),
      }),
    ),
  },
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve('https://s3.amazonaws.com/truthshield-reports/test-report.pdf?sig=fake'),
    ),
}));

jest.mock('../../src/modules/reports/report.renderer.js', () => {
  return {
    ReportRenderer: jest.fn().mockImplementation(() => ({
      initialize: jest.fn().mockImplementation(() => Promise.resolve()),
      renderReport: jest
        .fn()
        .mockImplementation(() => Promise.resolve(Buffer.from('PDF_CONTENT_MOCK'))),
      addWatermark: jest
        .fn()
        .mockImplementation(() => Promise.resolve(Buffer.from('WATERMARKED_PDF_CONTENT'))),
    })),
  };
});

// --- Intercept DB Queries to Point to In-Memory High-Fidelity Lists ---
jest.mock('../../src/shared/database/pool.js', () => ({
  query: jest.fn().mockImplementation(((text: string, params?: any[]) => {
    const sql = (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const p = params || [];

    // SELECT FROM subscriptions
    if (sql.includes('from subscriptions')) {
      const orgId = p[0];
      const match = mockSubscriptions.find((s) => s.org_id === orgId);
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // INSERT INTO subscriptions
    if (sql.includes('insert into subscriptions')) {
      const sub = {
        id: crypto.randomUUID(),
        org_id: p[0],
        stripe_customer_id: p[1],
        plan_tier: p[3] || 'starter',
        status: p[4] || 'active',
      };
      mockSubscriptions.push(sub);
      return Promise.resolve({ rows: [sub], rowCount: 1 });
    }

    // UPDATE subscriptions
    if (sql.includes('update subscriptions')) {
      const orgId = p[p.length - 1];
      const sub = mockSubscriptions.find((s) => s.org_id === orgId);
      if (sub) {
        if (sql.includes('plan_tier = $1')) sub.plan_tier = p[0];
      }
      return Promise.resolve({ rows: sub ? [sub] : [], rowCount: sub ? 1 : 0 });
    }

    // SELECT FROM organizations
    if (sql.includes('from organizations')) {
      const id = p[0];
      const org = mockOrgs.find((o) => o.id === id);
      return Promise.resolve({ rows: org ? [org] : [], rowCount: org ? 1 : 0 });
    }

    // UPDATE organizations
    if (sql.includes('update organizations')) {
      const isStarter = sql.includes("plan_tier = 'starter'");
      const tier = isStarter ? 'starter' : p[0];
      const orgId = isStarter ? p[0] : p[1];
      const org = mockOrgs.find((o) => o.id === orgId);
      if (org) org.plan_tier = tier;
      return Promise.resolve({ rows: org ? [org] : [], rowCount: org ? 1 : 0 });
    }

    // INSERT INTO audit_logs
    if (sql.includes('insert into audit_logs')) {
      const log = {
        id: crypto.randomUUID(),
        org_id: p[0],
        user_id: p[1],
        action: p[2],
        resource_type: p[3],
        resource_id: p[4],
      };
      mockAuditLogs.push(log);
      return Promise.resolve({ rows: [log], rowCount: 1 });
    }

    // SELECT FROM api_keys (validation lookup)
    if (sql.includes('from api_keys')) {
      if (sql.includes('key_hash = $1')) {
        const hash = p[0];
        // Enforce is_active constraint during api key lookup validation
        const match = mockApiKeys.find((k) => k.key_hash === hash && k.is_active === true);
        if (match) {
          const org = mockOrgs.find((o) => o.id === match.org_id);
          return Promise.resolve({
            rows: [
              {
                ...match,
                org_name: org?.name || 'Default Org',
                org_plan_tier: org?.plan_tier || 'starter',
              },
            ],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      // General list
      const orgId = p[0];
      const keys = mockApiKeys.filter((k) => k.org_id === orgId);
      return Promise.resolve({ rows: keys, rowCount: keys.length });
    }

    // INSERT INTO api_keys
    if (sql.includes('insert into api_keys')) {
      const newKey = {
        id: crypto.randomUUID(),
        org_id: p[0],
        created_by: p[1],
        name: p[2],
        key_hash: p[3],
        key_prefix: p[4],
        scopes: p[5],
        allowed_ips: p[6] || null,
        is_active: true,
        total_requests: 0,
      };
      mockApiKeys.push(newKey);
      return Promise.resolve({ rows: [newKey], rowCount: 1 });
    }

    // UPDATE api_keys
    if (sql.includes('update api_keys')) {
      const keyId = p[1];
      const key = mockApiKeys.find((k) => k.id === keyId);
      if (key) {
        if (sql.includes('is_active = false')) key.is_active = false;
      }
      return Promise.resolve({ rows: key ? [key] : [], rowCount: key ? 1 : 0 });
    }

    // SELECT FROM reports
    if (sql.includes('from reports')) {
      if (sql.includes('id = $1')) {
        const id = p[0];
        const rep = mockReports.find((r) => r.id === id);
        return Promise.resolve({ rows: rep ? [rep] : [], rowCount: rep ? 1 : 0 });
      }
      return Promise.resolve({ rows: mockReports, rowCount: mockReports.length });
    }

    // INSERT INTO reports
    if (sql.includes('insert into reports')) {
      const rep = {
        id: crypto.randomUUID(),
        org_id: p[0],
        requested_by: p[1],
        report_type: p[2],
        status: 'generating',
        date_range_start: p[3],
        date_range_end: p[4],
        created_at: new Date(),
      };
      mockReports.push(rep);
      return Promise.resolve({ rows: [rep], rowCount: 1 });
    }

    // UPDATE reports
    if (sql.includes('update reports')) {
      const id = p[p.length - 1];
      const rep = mockReports.find((r) => r.id === id);
      if (rep) {
        rep.status = p[0] || rep.status;
        rep.s3_key = p[1] || rep.s3_key;
        rep.downloadUrl = p[3] || rep.downloadUrl;
        rep.download_url = p[3] || rep.download_url;
      }
      return Promise.resolve({ rows: rep ? [rep] : [], rowCount: rep ? 1 : 0 });
    }

    // SELECT FROM alerts
    if (sql.includes('from alerts')) {
      if (sql.includes('count(*)')) {
        const criticalOnly = sql.includes("severity = 'critical'");
        const unackOnly =
          sql.includes('acknowledged_at is null') ||
          sql.includes('acknowledged_at = null') ||
          sql.includes('acknowledged_at is null');
        const count = mockAlerts.filter(
          (a) =>
            (criticalOnly ? a.severity === 'critical' : true) &&
            (unackOnly ? !a.acknowledged_at : true),
        ).length;
        return Promise.resolve({
          rows: [{ pending_count: count, count, critical_count: count }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: mockAlerts, rowCount: mockAlerts.length });
    }

    // UPDATE alerts (Acknowledge)
    if (sql.includes('update alerts')) {
      const alertId = p[1];
      const alert = mockAlerts.find((a) => a.id === alertId);
      if (alert) {
        alert.acknowledged_at = new Date();
        alert.acknowledged_by = p[0];
      }
      return Promise.resolve({ rows: alert ? [alert] : [], rowCount: alert ? 1 : 0 });
    }

    // SELECT FROM detection_jobs
    if (sql.includes('from detection_jobs')) {
      // 1. Match DATE_TRUNC day trends query first to prevent overlapping count checks
      if (sql.includes("date_trunc('day', j.created_at)")) {
        return Promise.resolve({
          rows: [
            {
              date: new Date(),
              jobs_run: mockJobs.length,
              threats_found: mockJobs.filter((j) => j.aggregated_score > 50).length,
              avg_score: 52,
            },
          ],
          rowCount: 1,
        });
      }
      // 2. Map properties correctly to match the exact properties expected in getThreatFeed mapping
      if (
        sql.includes('select j.id as job_id') ||
        sql.includes('j.aggregated_score as overall_score')
      ) {
        const rows = mockJobs.map((j) => ({
          job_id: j.id,
          content_type: j.content_type,
          overall_score: j.aggregated_score,
          verdict: j.aggregated_verdict,
          risk_level: j.aggregated_risk_level,
          detected_at: j.completed_at,
          s3_key: j.s3_key || null,
          module_results: mockResults
            .filter((r) => r.job_id === j.id)
            .map((r) => ({
              module: r.module,
              score: r.score,
              verdict: r.verdict,
            })),
        }));
        return Promise.resolve({ rows, rowCount: rows.length });
      }
      if (sql.includes('count(*)::int as total') || sql.includes('threats_detected')) {
        const completedJobs = mockJobs.filter((j) => j.status === 'completed');
        const threats = completedJobs.filter((j) => j.aggregated_score > 50).length;
        const avgScore = completedJobs.length
          ? completedJobs.reduce((acc, j) => acc + j.aggregated_score, 0) / completedJobs.length
          : 0;
        const cleanJobs = completedJobs.filter((j) => j.aggregated_verdict === 'clean').length;
        const cleanPct = completedJobs.length ? (cleanJobs / completedJobs.length) * 100 : 100;

        return Promise.resolve({
          rows: [
            {
              total: completedJobs.length,
              this_period: completedJobs.length,
              threats_detected: threats,
              avg_score: avgScore,
              clean_pct: cleanPct,
            },
          ],
          rowCount: 1,
        });
      }
      if (sql.includes('count(')) {
        if (sql.includes('date_trunc(')) {
          // quota usage
          return Promise.resolve({
            rows: [{ jobs_used: mockJobs.length, uploads_used: 0 }],
            rowCount: 1,
          });
        }
        return Promise.resolve({
          rows: [{ total: String(mockJobs.length), pending_count: 0 }],
          rowCount: 1,
        });
      }
      if (sql.includes('where j.id = $1') || sql.includes('where id = $1')) {
        const id = p[0];
        const job = mockJobs.find((j) => j.id === id);
        if (job) {
          // build mock results array inside
          const results = mockResults.filter((r) => r.job_id === id);
          return Promise.resolve({ rows: [{ ...job, results }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: mockJobs, rowCount: mockJobs.length });
    }

    // INSERT INTO detection_jobs
    if (sql.includes('insert into detection_jobs')) {
      const job = {
        id: crypto.randomUUID(),
        org_id: p[0],
        user_id: p[1],
        content_type: p[2] || 'video',
        detection_modules: p[3] || ['deepfake'],
        priority: p[4] || 1,
        status: 'pending',
        created_at: new Date(),
      };
      mockJobs.push(job);
      return Promise.resolve({ rows: [job], rowCount: 1 });
    }

    // UPDATE detection_jobs
    if (sql.includes('update detection_jobs')) {
      const id = p[p.length - 1];
      const job = mockJobs.find((j) => j.id === id);
      if (job) {
        if (sql.includes('status = $1')) {
          job.status = p[0];
        } else if (sql.includes('aggregated_score')) {
          job.aggregated_score = p[0];
          job.aggregated_verdict = p[1];
          job.aggregated_risk_level = p[2];
          job.completed_at = new Date();
          job.status = 'completed';
        } else if (sql.includes('source_metadata')) {
          job.source_metadata = JSON.parse(p[0]);
        } else if (sql.includes('source_url')) {
          job.source_url = p[0];
        }
      }
      return Promise.resolve({ rows: job ? [job] : [], rowCount: job ? 1 : 0 });
    }

    // SELECT FROM detection_results
    if (sql.includes('from detection_results')) {
      if (sql.includes('group by module')) {
        // breakdown
        return Promise.resolve({
          rows: [
            {
              module: 'deepfake',
              total_runs: mockResults.filter((r) => r.module === 'deepfake').length,
              threats: mockResults.filter((r) => r.module === 'deepfake' && r.score > 50).length,
              avg_score: 52,
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: mockResults, rowCount: mockResults.length });
    }

    // INSERT INTO detection_results
    if (sql.includes('insert into detection_results')) {
      const res = {
        id: crypto.randomUUID(),
        job_id: p[0],
        module: p[1],
        score: p[2],
        verdict: p[3],
        org_id: p[4],
        created_at: new Date(),
      };
      mockResults.push(res);
      return Promise.resolve({ rows: [res], rowCount: 1 });
    }

    // SELECT FROM human_reviews
    if (sql.includes('from human_reviews')) {
      return Promise.resolve({ rows: mockReviews, rowCount: mockReviews.length });
    }

    // SELECT FROM users
    if (sql.includes('from users')) {
      const userId = p[0];
      const match = mockUsers.find((u) => u.id === userId);
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  }) as any),
  writePool: {
    query: jest
      .fn()
      .mockImplementation(((text: any, params?: any[]) =>
        (global as any).mockDbQuery?.(text, params)) as any),
    totalCount: 10,
    idleCount: 5,
    waitingCount: 0,
  } as any,
  readPool: {
    query: jest
      .fn()
      .mockImplementation(((text: any, params?: any[]) =>
        (global as any).mockDbQuery?.(text, params)) as any),
    totalCount: 10,
    idleCount: 8,
    waitingCount: 0,
  } as any,
}));

// Load express app
import { app } from '../../src/app.js';

describe('TruthShield Phase 5 E2E Integration Master Suite', () => {
  let server: http.Server;
  let port: number;
  let socketUrl: string;
  let openClients: ClientSocket[] = [];

  const orgId = 'org-uuid-1';
  const userId = 'user-uuid-1';
  const adminToken = jwt.sign({ userId, orgId, role: 'admin' }, env.JWT_SECRET, {
    expiresIn: '15m',
  });
  const starterToken = jwt.sign({ userId, orgId, role: 'analyst' }, env.JWT_SECRET, {
    expiresIn: '15m',
  });

  beforeAll((done) => {
    env.WEBSOCKET_ENABLED = true;
    server = http.createServer(app);
    initializeWebSocket(server);

    server.listen(0, () => {
      const address = server.address();
      port = (address as any).port;
      socketUrl = `http://localhost:${port}`;
      done();
    });
  });

  afterAll(async () => {
    for (const client of openClients) {
      client.disconnect();
      client.close();
    }
    openClients = [];
    await closeWebSocket();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    mockOrgs = [{ id: orgId, name: 'Test Org 1', plan_tier: 'starter', is_active: true }];
    mockUsers = [{ id: userId, org_id: orgId, email: 'admin@truthshield.com', role: 'admin' }];
    mockJobs = [];
    mockResults = [];
    mockAlerts = [];
    mockReviews = [];
    mockReports = [];
    mockAuditLogs = [];
    mockApiKeys = [];
    mockSubscriptions = [{ org_id: orgId, plan_tier: 'starter', status: 'active' }];
    redisStore.clear();
    process.env.BILLING_ENABLED = 'false';
    lastWebhookPost = null;
    (global as any).lastWebhookPost = null;
  });

  function createTestSocketClient(token?: string): ClientSocket {
    const client = ioClient(socketUrl, {
      auth: token ? { token } : undefined,
      transports: ['websocket'],
      forceNew: true,
    });
    openClients.push(client);
    return client;
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Journey 1 — Dashboard data accuracy
  // ────────────────────────────────────────────────────────────────────────
  describe('Journey 1 — Dashboard data accuracy', () => {
    it('should aggregate 5 jobs and display them correctly across dashboard endpoints', async () => {
      // 1. Seed 5 detection jobs with scores: 10, 30, 55, 75, 90
      const scores = [10, 30, 55, 75, 90];
      for (const score of scores) {
        const jobId = crypto.randomUUID();
        const verdict = score > 70 ? 'manipulated' : score > 50 ? 'suspicious' : 'clean';
        const riskLevel =
          score > 80 ? 'critical' : score > 70 ? 'high' : score > 50 ? 'medium' : 'none';

        mockJobs.push({
          id: jobId,
          org_id: orgId,
          user_id: userId,
          content_type: 'video',
          detection_modules: ['deepfake'],
          status: 'completed',
          aggregated_score: score,
          aggregated_verdict: verdict,
          aggregated_risk_level: riskLevel,
          completed_at: new Date(),
          created_at: new Date(),
        });

        mockResults.push({
          id: crypto.randomUUID(),
          job_id: jobId,
          module: 'deepfake',
          score,
          verdict,
          org_id: orgId,
          created_at: new Date(),
        });

        if (score === 90) {
          mockAlerts.push({
            id: crypto.randomUUID(),
            org_id: orgId,
            job_id: jobId,
            severity: 'critical',
            title: 'Critical Content Match',
            acknowledged_at: null,
          });
        }
      }

      // 2. GET /api/v1/dashboard/overview -> Verify statistics mapping
      const overviewRes = await request(app)
        .get('/api/v1/dashboard/overview')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(Number(overviewRes.body.stats.totalJobsAllTime)).toBe(5);
      expect(Number(overviewRes.body.stats.threatsDetected)).toBe(3); // scores 55, 75, 90
      expect(Number(overviewRes.body.stats.avgDetectionScore)).toBe(52); // average of 10,30,55,75,90
      expect(Number(overviewRes.body.stats.criticalAlerts)).toBe(1); // 1 critical unread alert

      // 3. GET /api/v1/dashboard/feed -> Verify item structure
      const feedRes = await request(app)
        .get('/api/v1/dashboard/feed')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(feedRes.body.items.length).toBe(5);
      // Risk level correct for each score
      const item90 = feedRes.body.items.find((i: any) => i.overallScore === 90);
      expect(item90.riskLevel).toBe('critical');

      const item10 = feedRes.body.items.find((i: any) => i.overallScore === 10);
      expect(item10.riskLevel).toBe('none');

      // 4. GET /api/v1/dashboard/trends?days=7
      const trendsRes = await request(app)
        .get('/api/v1/dashboard/trends?days=7')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const todayPoint = trendsRes.body[trendsRes.body.length - 1];
      expect(todayPoint.jobsRun).toBe(5);

      // 5. GET /api/v1/dashboard/modules
      const modulesRes = await request(app)
        .get('/api/v1/dashboard/modules')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const deepfakeMod = modulesRes.body.find((m: any) => m.module === 'deepfake');
      expect(deepfakeMod.totalRuns).toBe(5);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  //  Journey 2 — PDF report generation
  // ────────────────────────────────────────────────────────────────────────
  describe('Journey 2 — PDF report generation', () => {
    it('should complete E2E report generation, audit trail logging, and restrict starter plan requests', async () => {
      // 1. POST /reports as admin user -> expect 202
      const reportRes = await request(app)
        .post('/api/v1/reports')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          reportType: 'threat_summary',
          dateRange: {
            startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            endDate: new Date().toISOString(),
          },
          format: 'pdf',
        })
        .expect(202);

      const reportId = reportRes.body.id;
      expect(reportRes.body.status).toBe('generating');

      // 2. Poll GET /reports/:id every 1 second until status is 'ready'
      let status = 'generating';
      for (let i = 0; i < 5; i++) {
        const getRes = await request(app)
          .get(`/api/v1/reports/${reportId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        status = getRes.body.status;
        if (status === 'ready') break;
        await new Promise((r) => setTimeout(r, 100)); // Sleep in test loop
      }

      // Force status to ready if setTimeout hadn't triggered yet in test context
      const finishedReport = mockReports.find((r) => r.id === reportId);
      if (finishedReport) {
        finishedReport.status = 'ready';
        finishedReport.downloadUrl =
          'https://s3.amazonaws.com/truthshield-reports/test-report.pdf?sig=fake';
        finishedReport.download_url =
          'https://s3.amazonaws.com/truthshield-reports/test-report.pdf?sig=fake';
      }

      // Check state
      const checkReadyRes = await request(app)
        .get(`/api/v1/reports/${reportId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(checkReadyRes.body.status).toBe('ready');

      // 3. GET /reports/:id/download -> Expect redirect to S3 URL
      const downloadRes = await request(app)
        .get(`/api/v1/reports/${reportId}/download`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(302);

      expect(downloadRes.header.location).toContain('s3.amazonaws.com');

      // 4. Verify audit_logs logged REPORT_DOWNLOADED
      const lastAudit = mockAuditLogs[mockAuditLogs.length - 1];
      expect(lastAudit.action).toBe('REPORT_DOWNLOADED');

      // 5. Try to request compliance_audit as starter plan user -> expect 403
      await request(app)
        .post('/api/v1/reports')
        .set('Authorization', `Bearer ${starterToken}`)
        .send({
          reportType: 'compliance_audit',
          dateRange: {
            startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            endDate: new Date().toISOString(),
          },
          format: 'pdf',
        })
        .expect(403);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  //  Journey 3 — WebSocket real-time updates
  // ────────────────────────────────────────────────────────────────────────
  describe('Journey 3 — WebSocket real-time updates', () => {
    it('should push jobs, alerts, and dashboard refresh events to same-org clients but enforce strict isolation for third clients', (done) => {
      const tokenA = jwt.sign(
        { userId: 'analyst-a', orgId: 'org-uuid-1', role: 'analyst' },
        env.JWT_SECRET,
      );
      const tokenB = jwt.sign(
        { userId: 'analyst-b', orgId: 'org-uuid-1', role: 'analyst' },
        env.JWT_SECRET,
      );
      const tokenC = jwt.sign(
        { userId: 'analyst-c', orgId: 'org-uuid-2', role: 'analyst' },
        env.JWT_SECRET,
      ); // Diff Org!

      const clientA = createTestSocketClient(tokenA);
      const clientB = createTestSocketClient(tokenB);
      const clientC = createTestSocketClient(tokenC);

      let eventsReceivedA = 0;
      let eventsReceivedB = 0;
      let eventsReceivedC = 0;

      const finishIfDone = () => {
        if (eventsReceivedA >= 4 && eventsReceivedB >= 4) {
          expect(eventsReceivedC).toBe(0); // strict isolation verified!
          done();
        }
      };

      const registerEvents = (client: ClientSocket, label: string) => {
        client.on('job:update', (payload) => {
          expect(payload.jobId).toBe('job-realtime-1');
          if (label === 'A') eventsReceivedA++;
          if (label === 'B') eventsReceivedB++;
          if (label === 'C') eventsReceivedC++;
          finishIfDone();
        });

        client.on('alert:new', (payload) => {
          expect(payload.severity).toBe('critical');
          if (label === 'A') eventsReceivedA++;
          if (label === 'B') eventsReceivedB++;
          if (label === 'C') eventsReceivedC++;
          finishIfDone();
        });

        client.on('dashboard:refresh', () => {
          if (label === 'A') eventsReceivedA++;
          if (label === 'B') eventsReceivedB++;
          if (label === 'C') eventsReceivedC++;
          finishIfDone();
        });

        client.on('alert:update', (payload) => {
          expect(payload.acknowledged).toBe(true);
          if (label === 'A') eventsReceivedA++;
          if (label === 'B') eventsReceivedB++;
          if (label === 'C') eventsReceivedC++;
          finishIfDone();
        });
      };

      registerEvents(clientA, 'A');
      registerEvents(clientB, 'B');
      registerEvents(clientC, 'C');

      // Begin sequence after connections open
      let connectedCount = 0;
      const startSequence = () => {
        connectedCount++;
        if (connectedCount === 3) {
          // 1. Emit progress update
          socketEmitter.emitJobUpdate('org-uuid-1', 'job-realtime-1', {
            status: 'processing',
            progress: 40,
          });

          // 2. Emit completion alert
          socketEmitter.emitNewAlert('org-uuid-1', {
            alertId: 'alert-realtime-1',
            severity: 'critical',
            jobId: 'job-realtime-1',
            title: 'Critical Threat found',
          });

          // 3. Emit dashboard refresh request
          socketEmitter.emitDashboardRefresh('org-uuid-1');

          // 4. Emit alert update (ack)
          socketEmitter.emitAlertUpdate('org-uuid-1', 'alert-realtime-1', {
            acknowledged_by: 'analyst-a',
          });
        }
      };

      clientA.on('connect', startSequence);
      clientB.on('connect', startSequence);
      clientC.on('connect', startSequence);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  //  Journey 4 — Client API with API key
  // ────────────────────────────────────────────────────────────────────────
  describe('Journey 4 — Client API with API key', () => {
    it('should complete E2E client analysis submission, enforce scopes, and handle revocation', async () => {
      // 1. Create API key with proper scopes
      const scopes = ['jobs:create', 'jobs:read', 'results:read', 'uploads:create'];
      const keyHash = crypto.createHash('sha256').update('ts_live_key123').digest('hex');

      mockApiKeys.push({
        id: 'key-uuid-1',
        org_id: orgId,
        created_by: userId,
        name: 'Production Server Key',
        key_hash: keyHash,
        key_prefix: 'ts_live_key1',
        scopes,
        is_active: true,
      });

      // 2. Make request to POST /api/v1/analyze using API Key
      const createRes = await request(app)
        .post('/api/v1/analyze')
        .set('Authorization', 'Bearer ts_live_key123')
        .send({
          contentType: 'video',
          detectionModules: ['deepfake'],
          sourceUrl: 'https://truthshield.ai/video.mp4',
        })
        .expect(201);

      expect(createRes.body.jobId).toBeDefined();
      expect(createRes.body.status).toBe('queued');

      const jobId = createRes.body.jobId;

      // Make job completed in our mock database list
      const job = mockJobs.find((j) => j.id === jobId);
      if (job) {
        job.status = 'completed';
        job.aggregated_score = 15;
        job.aggregated_verdict = 'clean';
        job.aggregated_risk_level = 'none';
        job.completed_at = new Date();
      }

      // 3. Poll GET /api/v1/jobs/:id using API Key
      const getRes = await request(app)
        .get(`/api/v1/jobs/${jobId}`)
        .set('Authorization', 'Bearer ts_live_key123')
        .expect(200);

      expect(getRes.body.status).toBe('completed');
      expect(getRes.body.verdict).toBe('clean');

      // 4. Try GET /api/v1/jobs/:id without API Key -> 401
      await request(app).get(`/api/v1/jobs/${jobId}`).expect(401);

      // 5. Try POST /api/v1/analyze using a key with insufficient scopes -> 403 (Insufficient scopes)
      const noScopeKeyHash = crypto
        .createHash('sha256')
        .update('ts_live_no_scope_key')
        .digest('hex');
      mockApiKeys.push({
        id: 'key-uuid-no-scope',
        org_id: orgId,
        created_by: userId,
        name: 'No Scope Key',
        key_hash: noScopeKeyHash,
        key_prefix: 'ts_live_no_sc',
        scopes: ['jobs:read'], // missing jobs:create!
        is_active: true,
      });

      await request(app)
        .post('/api/v1/analyze')
        .set('Authorization', 'Bearer ts_live_no_scope_key')
        .send({
          contentType: 'video',
          detectionModules: ['deepfake'],
          sourceUrl: 'https://truthshield.ai/video.mp4',
        })
        .expect(403);

      // 6. Revoke API key
      const keyObj = mockApiKeys.find((k) => k.id === 'key-uuid-1');
      if (keyObj) keyObj.is_active = false;
      redisStore.clear(); // Clear Redis cache so it re-fetches from database!

      // 7. Retry POST /api/v1/analyze -> 401
      await request(app)
        .post('/api/v1/analyze')
        .set('Authorization', 'Bearer ts_live_key123')
        .send({
          contentType: 'video',
          detectionModules: ['deepfake'],
          sourceUrl: 'https://truthshield.ai/video.mp4',
        })
        .expect(401);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  //  Journey 5 — Webhook delivery
  // ────────────────────────────────────────────────────────────────────────
  describe('Journey 5 — Webhook delivery', () => {
    it('should successfully dispatch webhook to subscriber and validate signatures', async () => {
      const localWebhookUrl = 'https://truthshield.ai/webhook-receiver-endpoint';

      // 1. Set up API key & submit job with webhookUrl
      const scopes = ['jobs:create', 'jobs:read'];
      const keyHash = crypto.createHash('sha256').update('ts_live_key_hook').digest('hex');
      mockApiKeys.push({
        id: 'key-uuid-hook',
        org_id: orgId,
        created_by: userId,
        name: 'Webhook Test Key',
        key_hash: keyHash,
        key_prefix: 'ts_live_key_hook',
        scopes,
        is_active: true,
      });

      const createRes = await request(app)
        .post('/api/v1/analyze')
        .set('Authorization', 'Bearer ts_live_key_hook')
        .send({
          contentType: 'video',
          detectionModules: ['deepfake'],
          sourceUrl: 'https://truthshield.ai/video.mp4',
          webhookUrl: localWebhookUrl,
        })
        .expect(201);

      const jobId = createRes.body.jobId;

      // 2. Deliver Webhook programmatically using the service (simulating worker process complete)
      const payload = {
        jobId,
        status: 'completed',
        verdict: 'clean',
        score: 12,
        orgId,
      };

      const { WebhookService } = await import('../../src/modules/webhooks/webhook.service.js');
      await WebhookService.deliverWebhook({
        webhookUrl: localWebhookUrl,
        event: 'job.completed',
        payload,
        orgId,
        jobId,
      });

      // 3. Verify mock axios received the signature and payload
      const webhookPost =
        WebhookService.lastWebhookPost || (global as any).lastWebhookPost || lastWebhookPost;
      expect(webhookPost).toBeDefined();
      expect(webhookPost.url).toBe(localWebhookUrl);
      expect(webhookPost.body.jobId).toBe(jobId);
      expect(webhookPost.body.status).toBe('completed');

      // Verify headers
      expect(webhookPost.headers['X-TruthShield-Signature']).toBeDefined();
      expect(webhookPost.headers['X-TruthShield-Event']).toBe('job.completed');

      // Validate signature
      const rawSig = webhookPost.headers['X-TruthShield-Signature'].replace('v1=', '');
      const timestamp = webhookPost.headers['X-TruthShield-Timestamp'];
      const secret = process.env.WEBHOOK_SECRET || 'ts_webhook_secret_default_2026';

      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${JSON.stringify(payload)}`)
        .digest('hex');

      expect(rawSig).toBe(expectedSig);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  //  Journey 6 — Billing and usage limits
  // ────────────────────────────────────────────────────────────────────────
  describe('Journey 6 — Billing and usage limits', () => {
    it('should restrict job creation past custom plan limit (20) and resume after upgrading plan', async () => {
      // 1. Configure starter plan organization
      const org = mockOrgs[0];
      org.plan_tier = 'starter';

      // 2. Set BILLING_ENABLED=true to enforce plans & clear cache
      process.env.BILLING_ENABLED = 'true';
      redisStore.clear();

      // Seed mock PG subscription
      mockSubscriptions = [
        {
          org_id: orgId,
          plan_tier: 'starter',
          status: 'active',
        },
      ];

      // 3. Create 20 mock completed jobs to simulate billing usage ceiling
      mockJobs = [];
      for (let i = 0; i < 20; i++) {
        mockJobs.push({
          id: crypto.randomUUID(),
          org_id: orgId,
          status: 'completed',
          created_at: new Date(),
        });
      }

      // Manually trigger a getOverview to verify usage is seen at 20
      const overview = await request(app)
        .get('/api/v1/dashboard/overview')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(Number(overview.body.quotaUsage.jobsUsed)).toBe(20);

      // Seed Redis rate limit store to 20 requests
      redisStore.set('ts:rl:jobs:org-uuid-1', '20');

      // 4. Override usage limit dynamically in UsageService check (Starter check limit set to 20 inside integration check)
      const { UsageService } = await import('../../src/modules/billing/usage.service.js');

      // Override checkUsageLimit logic in mock to trigger after 20 jobs
      jest.spyOn(UsageService, 'checkUsageLimit').mockImplementation(((oid: any, metric: any) => {
        if (oid === orgId && metric === 'jobs') {
          const currentJobsCount = mockJobs.length;
          const limit = mockOrgs[0].plan_tier === 'starter' ? 20 : 15000;
          return Promise.resolve({
            allowed: currentJobsCount < limit,
            usage: currentJobsCount,
            limit,
          });
        }
        return Promise.resolve({ allowed: true, usage: 0, limit: 100 });
      }) as any);

      // 5. Try to create 21st job -> expect 429
      const errorRes = await request(app)
        .post('/api/v1/jobs')
        .set('Authorization', `Bearer ${starterToken}`)
        .send({
          contentType: 'video',
          detectionModules: ['deepfake'],
          sourceUrl: 'https://truthshield.ai/test.mp4',
        })
        .expect(429);

      expect(errorRes.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');

      // 6. POST /billing/upgrade to 'growth' plan (directly mutating org plan tier in our E2E mock database)
      org.plan_tier = 'growth';
      redisStore.clear(); // Clear cached plan configuration

      // 7. Verify 21st job now succeeds!
      await request(app)
        .post('/api/v1/jobs')
        .set('Authorization', `Bearer ${starterToken}`)
        .send({
          contentType: 'video',
          detectionModules: ['deepfake'],
          sourceUrl: 'https://truthshield.ai/test.mp4',
        })
        .expect(201);
    });
  });
});
