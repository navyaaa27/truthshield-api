/* eslint-disable @typescript-eslint/ban-ts-comment */
import request from 'supertest';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';
import { app } from '../src/app.js';

// In-Memory Database and Store Mock states
let mockOrganizations: any[] = [];
let mockUsers: any[] = [];
let mockReports: any[] = [];
let mockAuditLogs: any[] = [];
let mockRedisStore: Record<string, string> = {};
let mockIncrCounts: Record<string, number> = {};

// Mock Redis client
jest.mock('../src/shared/redis/redis.client.js', () => ({
  redisClient: {
    get: jest.fn().mockImplementation(((key: any) => Promise.resolve(mockRedisStore[key] || null)) as any),
    setex: jest.fn().mockImplementation(((key: any, _ttl: any, val: any) => {
      mockRedisStore[key] = val;
      mockRedisStore[`ts:${key}`] = val;
      return Promise.resolve('OK');
    }) as any),
    del: jest.fn().mockImplementation(((...keys: any[]) => {
      for (const k of keys) {
        delete mockRedisStore[`ts:${k}`];
        delete mockRedisStore[k];
      }
      return Promise.resolve(1);
    }) as any),
    keys: jest.fn().mockImplementation(((pattern: string) => {
      const glob = pattern.replace('*', '');
      const matched = Object.keys(mockRedisStore).filter((k) => k.startsWith(glob));
      return Promise.resolve(matched);
    }) as any),
    incr: jest.fn().mockImplementation(((key: any) => {
      mockIncrCounts[key] = (mockIncrCounts[key] || 0) + 1;
      mockRedisStore[key] = mockIncrCounts[key].toString();
      return Promise.resolve(mockIncrCounts[key]);
    }) as any),
    expire: jest.fn().mockImplementation((() => Promise.resolve(1)) as any),
    call: jest.fn().mockImplementation(((command: string, ...args: any[]) => {
      const cmd = command.toLowerCase();
      if (cmd === 'script' && args[0]?.toLowerCase() === 'load') {
        return Promise.resolve('fake_sha_hash');
      }
      if (cmd === 'evalsha' || cmd === 'eval') {
        const key = args.find(arg => typeof arg === 'string' && (arg.startsWith('ts:rl:') || arg.startsWith('ts:sd:'))) || 'unknown_key';
        const val = parseInt(mockRedisStore[key] || '0', 10) + 1;
        mockRedisStore[key] = val.toString();
        return Promise.resolve([val, 60]); 
      }
      return Promise.resolve();
    }) as any),
    on: jest.fn(),
  },
}));

// Mock Redis index entry point
jest.mock('../src/shared/redis/index.js', () => ({
  redis: {
    get: jest.fn().mockImplementation(((key: any) => Promise.resolve(mockRedisStore[key] || null)) as any),
    set: jest.fn().mockImplementation(((key: any, val: any) => {
      mockRedisStore[key] = val;
      return Promise.resolve('OK');
    }) as any),
    del: jest.fn().mockImplementation(((key: any) => {
      delete mockRedisStore[key];
      return Promise.resolve(1);
    }) as any),
    ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
    quit: jest.fn().mockImplementation(() => Promise.resolve()),
  },
}));

// Mock ioredis completely
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: jest.fn().mockImplementation(((key: any) => Promise.resolve(mockRedisStore[key] || null)) as any),
    set: jest.fn().mockImplementation(((key: any, val: any) => {
      mockRedisStore[key] = val;
      return Promise.resolve('OK');
    }) as any),
    ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
    on: jest.fn(),
  }));
});

// Mock Database Connection and Pool
jest.mock('../src/shared/database/pool.js', () => {
  return {
    writePool: {
      connect: jest.fn().mockImplementation(() =>
        Promise.resolve({
          query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
          release: jest.fn(),
        })
      ),
      end: jest.fn().mockImplementation(() => Promise.resolve()),
    },
    readPool: {
      connect: jest.fn().mockImplementation(() =>
        Promise.resolve({
          query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
          release: jest.fn(),
        })
      ),
      end: jest.fn().mockImplementation(() => Promise.resolve()),
    },
    query: jest.fn().mockImplementation(((text: any, params?: any[]) => {
      const sql = (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const p = params || [];

      // 1. Organization profile
      if (sql.includes('select * from organizations where id = $1')) {
        const org = mockOrganizations.find((o) => o.id === p[0]);
        return Promise.resolve({
          rows: org ? [org] : [],
          rowCount: org ? 1 : 0,
        });
      }

      // 2. User profile
      if (sql.includes('select * from users where id = $1')) {
        const user = mockUsers.find((u) => u.id === p[0]);
        return Promise.resolve({
          rows: user ? [user] : [],
          rowCount: user ? 1 : 0,
        });
      }

      // 3. User details by requested_by in report service
      if (sql.includes('select email from users where id = $1')) {
        const user = mockUsers.find((u) => u.id === p[0]);
        return Promise.resolve({
          rows: user ? [{ email: user.email }] : [],
          rowCount: user ? 1 : 0,
        });
      }

      // 4. Insert report record
      if (sql.includes('insert into reports') && sql.includes('generating')) {
        const newReport = {
          id: 'report-uuid-xyz-' + Math.floor(Math.random() * 1000),
          org_id: p[0],
          requested_by: p[1],
          report_type: p[2],
          status: 'generating',
          date_range_start: p[3],
          date_range_end: p[4],
          created_at: new Date(),
        };
        mockReports.push(newReport);
        return Promise.resolve({
          rows: [newReport],
          rowCount: 1,
        });
      }

      // 5. Select report by ID
      if (sql.includes('select * from reports where id = $1')) {
        const report = mockReports.find((r) => r.id === p[0]);
        return Promise.resolve({
          rows: report ? [report] : [],
          rowCount: report ? 1 : 0,
        });
      }

      // 6. Update report status/details
      if (sql.startsWith('update reports set status =')) {
        let status = 'ready';
        if (sql.includes("status = 'failed'")) status = 'failed';
        else if (sql.includes("status = 'expired'")) status = 'expired';
        else if (p[0] === 'ready' || p[0] === 'failed' || p[0] === 'expired') status = p[0];

        let reportId = '';
        if (sql.includes('where id = $7')) reportId = p[6];
        else if (sql.includes('where id = $2')) reportId = p[1];
        else if (sql.includes('where id = $1')) reportId = p[0];

        const report = mockReports.find((r) => r.id === reportId);
        if (report) {
          report.status = status;
          if (status === 'ready') {
            report.s3_key = p[0];
            report.file_size_bytes = p[1];
            report.total_pages = p[2];
            report.download_url = p[3];
            report.expires_at = p[4];
            report.job_count = p[5];
          } else if (status === 'failed') {
            report.error_message = p[0];
          } else if (status === 'expired') {
            report.download_url = null;
            report.downloadUrl = undefined;
          }
        }
        return Promise.resolve({ rows: report ? [report] : [], rowCount: report ? 1 : 0 });
      }

      // 7. Audit Log inserts
      if (sql.includes('insert into audit_logs')) {
        const log = {
          org_id: p[0],
          user_id: p[1],
          action: p[2],
          resource_type: p[3],
          resource_id: p[4],
          created_at: new Date(),
        };
        mockAuditLogs.push(log);
        return Promise.resolve({ rows: [log], rowCount: 1 });
      }

      // 8. List reports
      if (sql.includes('select * from reports where org_id = $1')) {
        return Promise.resolve({
          rows: mockReports.filter((r) => r.org_id === p[0]),
          rowCount: mockReports.filter((r) => r.org_id === p[0]).length,
        });
      }

      // 9. Count reports
      if (sql.includes('select count(*)::int as count from reports')) {
        return Promise.resolve({
          rows: [{ count: mockReports.filter((r) => r.org_id === p[0]).length }],
          rowCount: 1,
        });
      }

      // 10. Delete report
      if (sql.includes('delete from reports where id = $1')) {
        const idx = mockReports.findIndex((r) => r.id === p[0]);
        if (idx !== -1) {
          mockReports.splice(idx, 1);
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      // Fallback response for dashboard/jobs integration queries in report assembler
      return Promise.resolve({ rows: [], rowCount: 0 });
    }) as any),
  };
});

// Mock AWS S3 client and commands
jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => ({
      send: (jest.fn() as any).mockResolvedValue({}),
    })),
    PutObjectCommand: jest.fn(),
    DeleteObjectCommand: jest.fn(),
    GetObjectCommand: jest.fn(),
  };
});

// Mock AWS S3 pre-signed URL generation helper
jest.mock('@aws-sdk/s3-request-presigner', () => {
  return {
    getSignedUrl: (jest.fn() as any).mockResolvedValue('https://mock-s3-signed-url.com/report.pdf'),
  };
});

// Mock nodemailer email dispatcher
jest.mock('nodemailer', () => {
  return {
    createTransport: jest.fn().mockImplementation(() => ({
      sendMail: (jest.fn() as any).mockResolvedValue({ messageId: 'mock-mail-id' }),
    })),
  };
});

// Mock Puppeteer browser renderer completely
jest.mock('puppeteer', () => {
  return {
    launch: jest.fn().mockImplementation(() => {
      return Promise.resolve({
        newPage: jest.fn().mockImplementation(() => {
          return Promise.resolve({
            setContent: jest.fn().mockImplementation(() => Promise.resolve(undefined)),
            setDefaultNavigationTimeout: jest.fn().mockImplementation(() => Promise.resolve(undefined)),
            pdf: jest.fn().mockImplementation(() => Promise.resolve(Buffer.from('MOCK_PDF_BINARY_DATA'))),
            close: jest.fn().mockImplementation(() => Promise.resolve(undefined)),
          });
        }),
        close: jest.fn().mockImplementation(() => Promise.resolve(undefined)),
      });
    }),
  };
});

// Mock BullMQ Queue and Worker completely
jest.mock('bullmq', () => {
  return {
    Queue: jest.fn().mockImplementation(() => ({
      add: jest.fn().mockImplementation(() => Promise.resolve({ id: 'mock-job-id', name: 'generate-report' })),
      getJobCounts: jest.fn().mockImplementation(() => Promise.resolve({ waiting: 0 })),
      on: jest.fn().mockImplementation(() => {}),
    })),
    Worker: jest.fn().mockImplementation(() => ({
      on: jest.fn().mockImplementation(() => {}),
    })),
  };
});

describe('TruthShield PDF Audit Reports Suite', () => {
  const orgId = 'org-uuid-1111';
  const userId = 'user-uuid-2222';
  let starterToken: string;
  let growthToken: string;
  let proToken: string;

  beforeEach(() => {
    app.set('trust proxy', true);
    mockOrganizations = [
      { id: orgId, name: 'Starter Org', plan_tier: 'starter' },
      { id: 'org-growth', name: 'Growth Org', plan_tier: 'growth' },
      { id: 'org-pro', name: 'Pro Org', plan_tier: 'pro' },
    ];
    mockUsers = [
      { id: userId, org_id: orgId, email: 'user@starter.com', role: 'admin' },
      { id: 'user-growth', org_id: 'org-growth', email: 'user@growth.com', role: 'admin' },
      { id: 'user-pro', org_id: 'org-pro', email: 'user@pro.com', role: 'admin' },
    ];
    mockReports = [];
    mockAuditLogs = [];

    // Tokens
    starterToken = jwt.sign({ userId, orgId, role: 'admin' }, env.JWT_SECRET || 'test-secret');
    growthToken = jwt.sign({ userId: 'user-growth', orgId: 'org-growth', role: 'admin' }, env.JWT_SECRET || 'test-secret');
    proToken = jwt.sign({ userId: 'user-pro', orgId: 'org-pro', role: 'admin' }, env.JWT_SECRET || 'test-secret');
  });

  afterAll(async () => {
    // Shutdown report renderer browser if active
    const { reportService } = await import('../src/modules/reports/report.service.js');
    await (reportService as any).renderer.shutdown();
  });

  describe('Journey 1: Enqueue PDF Report Request & Plan Access validations', () => {
    it('Starter plan orgs should successfully request threat_summary but fail other report types', async () => {
      // 1. Success on threat_summary
      const res1 = await request(app)
        .post('/api/v1/reports')
        .set('Authorization', `Bearer ${starterToken}`)
        .send({
          reportType: 'threat_summary',
          dateRange: { startDate: '2026-05-01', endDate: '2026-05-15' },
          format: 'pdf',
        });

      expect(res1.status).toBe(202);
      expect(res1.body.status).toBe('generating');
      expect(res1.body.report_type).toBe('threat_summary');

      // Verify audit log
      const log1 = mockAuditLogs.find((l) => l.action === 'REPORT_GENERATION_INITIATED');
      expect(log1).toBeDefined();

      // 2. Forbidden access on dmca_bundle
      const res2 = await request(app)
        .post('/api/v1/reports')
        .set('Authorization', `Bearer ${starterToken}`)
        .send({
          reportType: 'dmca_bundle',
          dateRange: { startDate: '2026-05-01', endDate: '2026-05-15' },
          format: 'pdf',
        });

      expect(res2.status).toBe(403);
    });

    it('Growth tier orgs should access threat_summary and job_detail but fail dmca_bundle', async () => {
      // 1. Success on job_detail
      const res1 = await request(app)
        .post('/api/v1/reports')
        .set('Authorization', `Bearer ${growthToken}`)
        .send({
          reportType: 'job_detail',
          dateRange: { startDate: '2026-05-01', endDate: '2026-05-15' },
          format: 'pdf',
        });

      expect(res1.status).toBe(202);

      // 2. Forbidden access on dmca_bundle
      const res2 = await request(app)
        .post('/api/v1/reports')
        .set('Authorization', `Bearer ${growthToken}`)
        .send({
          reportType: 'dmca_bundle',
          dateRange: { startDate: '2026-05-01', endDate: '2026-05-15' },
          format: 'pdf',
        });

      expect(res2.status).toBe(403);
    });

    it('Pro/Enterprise tier orgs should successfully request all report types', async () => {
      const res = await request(app)
        .post('/api/v1/reports')
        .set('Authorization', `Bearer ${proToken}`)
        .send({
          reportType: 'dmca_bundle',
          dateRange: { startDate: '2026-05-01', endDate: '2026-05-15' },
          format: 'pdf',
        });

      expect(res.status).toBe(202);
    });

    it('Should return 400 bad request if the date range exceeds 365 days', async () => {
      const res = await request(app)
        .post('/api/v1/reports')
        .set('Authorization', `Bearer ${proToken}`)
        .send({
          reportType: 'threat_summary',
          dateRange: { startDate: '2025-01-01', endDate: '2026-05-15' }, // >365 days
          format: 'pdf',
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.message || res.body.message).toContain('duration of 365 days');
    });
  });

  describe('Journey 2: Listing organization reports', () => {
    it('Should fetch a paginated list of reports for the organization', async () => {
      // Mock existing reports
      mockReports = [
        { id: 'rep-1', org_id: orgId, report_type: 'threat_summary', status: 'ready', created_at: new Date() },
        { id: 'rep-2', org_id: orgId, report_type: 'threat_summary', status: 'failed', created_at: new Date() },
        { id: 'rep-3', org_id: 'org-growth', report_type: 'threat_summary', status: 'ready', created_at: new Date() },
      ];

      const res = await request(app)
        .get('/api/v1/reports')
        .set('Authorization', `Bearer ${starterToken}`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.reports.length).toBe(2);
      expect(res.body.reports[0].id).toBe('rep-1');
    });
  });

  describe('Journey 3: Report Worker processing enqueued PDF tasks', () => {
    it('Should process the job enqueued task, render PDF, save to S3, and trigger email dispatches', async () => {
      const reportId = 'report-1234';
      mockReports = [{
        id: reportId,
        org_id: orgId,
        requested_by: userId,
        report_type: 'threat_summary',
        status: 'generating',
        date_range_start: new Date('2026-05-01'),
        date_range_end: new Date('2026-05-15'),
      }];

      const { ReportWorker } = await import('../src/shared/queue/report.worker.js');
      const worker = new ReportWorker();

      // Trigger worker processing synchronously
      const mockJob = { data: { reportId } };
      await worker.process(mockJob as any);

      // Verify report was compiled and state is updated to 'ready'
      const updatedReport = mockReports.find((r) => r.id === reportId);
      expect(updatedReport).toBeDefined();
      expect(updatedReport.status).toBe('ready');
      expect(updatedReport.download_url).toBe('https://mock-s3-signed-url.com/report.pdf');
    });

    it('Should handle execution failures gracefully and update status to failed', async () => {
      const reportId = 'report-fail';
      mockReports = [{
        id: reportId,
        org_id: orgId,
        requested_by: userId,
        report_type: 'threat_summary',
        status: 'generating',
        date_range_start: new Date('2026-05-01'),
        date_range_end: new Date('2026-05-15'),
      }];

      const { ReportWorker } = await import('../src/shared/queue/report.worker.js');
      const worker = new ReportWorker();

      // Simulate a failure during processing
      const error = new Error('Puppeteer browser crash');
      await (worker as any).handleFailure({ data: { reportId } } as any, error);

      const updatedReport = mockReports.find((r) => r.id === reportId);
      expect(updatedReport).toBeDefined();
      expect(updatedReport.status).toBe('failed');
      expect(updatedReport.error_message).toBe('Puppeteer browser crash');
    });
  });

  describe('Journey 4: Accessing PDF Reports and Handling Expirations', () => {
    it('Should fetch a single report metadata and return its temporary secure download URL', async () => {
      const reportId = 'rep-ready';
      mockReports = [{
        id: reportId,
        org_id: orgId,
        requested_by: userId,
        report_type: 'threat_summary',
        status: 'ready',
        expires_at: new Date(Date.now() + 120000), // In future
        download_url: 'https://mock-s3-signed-url.com/report.pdf',
      }];

      const res = await request(app)
        .get(`/api/v1/reports/${reportId}`)
        .set('Authorization', `Bearer ${starterToken}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.download_url).toBe('https://mock-s3-signed-url.com/report.pdf');

      // Verify audit logs
      const log = mockAuditLogs.find((l) => l.action === 'REPORT_ACCESSED');
      expect(log).toBeDefined();
    });

    it('Should update status to "expired" and deny temporary links if report has passed its 24h expiration', async () => {
      const reportId = 'rep-expired';
      mockReports = [{
        id: reportId,
        org_id: orgId,
        requested_by: userId,
        report_type: 'threat_summary',
        status: 'ready',
        expires_at: new Date(Date.now() - 10000), // Already expired
        download_url: 'https://mock-s3-signed-url.com/report.pdf',
      }];

      const res = await request(app)
        .get(`/api/v1/reports/${reportId}`)
        .set('Authorization', `Bearer ${starterToken}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('expired');
      expect(res.body.download_url).toBeNull();
    });
  });

  describe('Journey 5: Delete generated PDF reports', () => {
    it('Should securely delete S3 storage assets and remove the report DB record', async () => {
      const reportId = 'rep-delete';
      mockReports = [{
        id: reportId,
        org_id: orgId,
        requested_by: userId,
        report_type: 'threat_summary',
        status: 'ready',
        s3_key: `${orgId}/reports/${reportId}.pdf`,
      }];

      const res = await request(app)
        .delete(`/api/v1/reports/${reportId}`)
        .set('Authorization', `Bearer ${starterToken}`);

      expect(res.status).toBe(204);

      // Verify report was deleted from DB
      const report = mockReports.find((r) => r.id === reportId);
      expect(report).toBeUndefined();

      // Verify audit log
      const log = mockAuditLogs.find((l) => l.action === 'REPORT_DELETED');
      expect(log).toBeDefined();
    });
  });
});
