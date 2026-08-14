/* eslint-disable @typescript-eslint/ban-ts-comment */
process.env.ENABLE_SECURITY_MIDDLEWARE = 'false';
import request from 'supertest';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

// --- Multi-Channel Notification Fail Flags ---
let emailFailFlag = false;

// Mock nodemailer
jest.mock('nodemailer', () => {
  return {
    createTransport: jest.fn().mockImplementation(() => {
      return {
        sendMail: jest.fn().mockImplementation(() => {
          if (emailFailFlag) {
            return Promise.reject(new Error('SMTP Transport Error'));
          }
          return Promise.resolve({ messageId: 'mock-email-id-123' });
        }),
      };
    }),
  };
});

// Mock @slack/webhook
jest.mock('@slack/webhook', () => {
  return {
    IncomingWebhook: jest.fn().mockImplementation(() => {
      return {
        send: jest.fn().mockImplementation(() => Promise.resolve({ text: 'ok' })),
      };
    }),
  };
});

// --- Mock Database State ---
let mockReviews: any[] = [];
let mockResults: any[] = [];
let mockJobs: any[] = [];
let mockOrganizations: any[] = [];
let mockUsers: any[] = [];
let mockAlerts: any[] = [];
let mockAuditLogs: any[] = [];
let mockRedisStore: Record<string, string> = {};

function resetMockState() {
  mockReviews = [];
  mockResults = [];
  mockJobs = [];
  mockOrganizations = [
    { id: 'org-uuid-1', name: 'Starter Org', domain: 'starter.com', plan_tier: 'starter' },
    { id: 'org-uuid-2', name: 'Pro Org', domain: 'pro.com', plan_tier: 'pro' },
    { id: 'org-uuid-3', name: 'Enterprise Org', domain: 'enterprise.com', plan_tier: 'enterprise' },
  ];
  mockUsers = [
    { id: 'user-admin', email: 'admin@starter.com', role: 'admin', organization_id: 'org-uuid-1' },
    {
      id: 'user-analyst',
      email: 'analyst@starter.com',
      role: 'analyst',
      organization_id: 'org-uuid-1',
    },
    {
      id: 'user-regular',
      email: 'regular@starter.com',
      role: 'user',
      organization_id: 'org-uuid-1',
    },
  ];
  mockAlerts = [];
  mockAuditLogs = [];
  mockRedisStore = {};
  emailFailFlag = false;
}

// Mock postgres pool & query
jest.mock('../src/shared/database/pool.js', () => {
  return {
    pool: {
      connect: jest.fn().mockImplementation(() =>
        Promise.resolve({
          query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
          release: jest.fn(),
        }),
      ),
      end: jest.fn().mockImplementation(() => Promise.resolve()),
    },
    testConnection: jest.fn().mockImplementation(() => Promise.resolve()),
    query: jest.fn().mockImplementation(((text: any, params?: any[]) => {
      const sql = (text || '').trim().toLowerCase();
      const p = params || [];

      // SELECT plan_tier FROM organizations
      if (
        sql.startsWith('select plan_tier from organizations') ||
        sql.startsWith('select * from organizations')
      ) {
        const id = p[0];
        const org = mockOrganizations.find((o) => o.id === id);
        return Promise.resolve({ rows: org ? [org] : [], rowCount: org ? 1 : 0 });
      }

      // SELECT role FROM users
      if (sql.startsWith('select role from users') || sql.startsWith('select * from users')) {
        const id = p[0];
        const user = mockUsers.find((u) => u.id === id);
        return Promise.resolve({ rows: user ? [user] : [], rowCount: user ? 1 : 0 });
      }

      // SELECT COUNT(*)::int as count FROM human_reviews WHERE assigned_to
      if (
        sql.includes('count(*)::int as count from human_reviews') &&
        sql.includes('assigned_to = $1')
      ) {
        const analystId = p[0];
        const count = mockReviews.filter(
          (r) => r.assigned_to === analystId && ['assigned', 'in_review'].includes(r.status),
        ).length;
        return Promise.resolve({ rows: [{ count }], rowCount: 1 });
      }

      // SELECT * FROM human_reviews WHERE id = $1
      if (sql.startsWith('select * from human_reviews') && sql.includes('where id = $1')) {
        const id = p[0];
        const review = mockReviews.find((r) => r.id === id);
        return Promise.resolve({ rows: review ? [review] : [], rowCount: review ? 1 : 0 });
      }

      // SELECT hr.*, json_build_object... FROM human_reviews hr
      if (sql.includes('from human_reviews hr') && sql.includes('hr.id = $1')) {
        const id = p[0];
        const review = mockReviews.find((r) => r.id === id);
        if (review) {
          const job = mockJobs.find((j) => j.id === review.job_id) || {
            id: review.job_id,
            content_type: 'image',
            status: 'completed',
            org_id: review.org_id,
          };
          const result = mockResults.find((res) => res.id === review.result_id) || {
            id: review.result_id,
            module: 'deepfake',
            score: review.ai_score,
            verdict: review.ai_verdict,
          };
          return Promise.resolve({
            rows: [{ ...review, job, result }],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // SELECT * FROM human_reviews WHERE status = 'pending' ...
      if (
        (sql.includes('from human_reviews') &&
          !sql.includes('count') &&
          !sql.includes('avg_hours')) ||
        sql.includes('from human_reviews hr')
      ) {
        let rows = [...mockReviews];
        if (sql.includes('org_id = $1')) {
          rows = rows.filter((r) => r.org_id === p[0]);
        }
        if (sql.includes('sla_deadline < now()')) {
          rows = rows.filter(
            (r) =>
              r.sla_deadline < new Date() &&
              !['completed', 'auto_resolved', 'escalated'].includes(r.status),
          );
        }
        if (sql.includes('assigned_to = $1')) {
          rows = rows.filter((r) => r.assigned_to === p[0]);
        }
        return Promise.resolve({ rows, rowCount: rows.length });
      }

      // SELECT * FROM detection_results WHERE job_id = $1
      if (sql.startsWith('select * from detection_results') && sql.includes('job_id = $1')) {
        const jobId = p[0];
        const rows = mockResults.filter((r) => r.job_id === jobId);
        return Promise.resolve({ rows, rowCount: rows.length });
      }

      // SELECT * FROM detection_results WHERE id = $1
      if (sql.startsWith('select * from detection_results') && sql.includes('where id = $1')) {
        const id = p[0];
        const res = mockResults.find((r) => r.id === id);
        return Promise.resolve({ rows: res ? [res] : [], rowCount: res ? 1 : 0 });
      }

      // INSERT INTO human_reviews
      if (sql.startsWith('insert into human_reviews')) {
        const newReview = {
          id: `review-${mockReviews.length + 1}`,
          result_id: p[0],
          job_id: p[1],
          org_id: p[2],
          status: 'pending',
          priority: p[3],
          ai_score: p[4],
          ai_verdict: p[5],
          sla_deadline: p[6],
          assigned_to: null,
          assigned_at: null,
          started_at: null,
          completed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        mockReviews.push(newReview);
        return Promise.resolve({ rows: [newReview], rowCount: 1 });
      }

      // UPDATE human_reviews
      if (sql.startsWith('update human_reviews')) {
        const id = p[p.length - 1];
        const review = mockReviews.find((r) => r.id === id);
        if (review) {
          if (sql.includes('assigned_to = $1')) {
            review.assigned_to = p[0];
            review.assigned_at = new Date();
            review.status = 'assigned';
          } else if (sql.includes('started_at = now()')) {
            review.started_at = new Date();
            review.status = 'in_review';
          } else if (sql.includes('reviewer_verdict = $1')) {
            review.reviewer_verdict = p[0];
            review.reviewer_notes = p[1];
            review.reviewer_confidence = p[2];
            review.override_reason = p[3];
            review.completed_at = new Date();
            review.status = 'completed';
          } else if (sql.includes("status = 'escalated'")) {
            review.status = 'escalated';
            review.reviewer_notes = (review.reviewer_notes || '') + '\nEscalation Reason: ' + p[0];
          } else if (sql.includes("status = 'auto_resolved'")) {
            review.status = 'auto_resolved';
            review.reviewer_verdict = review.ai_verdict;
            review.override_reason = 'auto_resolved_sla_breach';
            review.completed_at = new Date();
          }
          review.updated_at = new Date();
          return Promise.resolve({ rows: [review], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // UPDATE detection_results
      if (sql.startsWith('update detection_results')) {
        const id = p[p.length - 1];
        const res = mockResults.find((r) => r.id === id);
        if (res) {
          res.verdict = p[0];
          res.flags = p[1];
          res.reviewed_by = p[2];
          res.reviewed_at = new Date();
          res.review_notes = p[3];
          return Promise.resolve({ rows: [res], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // UPDATE detection_jobs
      if (sql.startsWith('update detection_jobs')) {
        const id = p[p.length - 1];
        const job = mockJobs.find((j) => j.id === id);
        if (job) {
          job.aggregated_score = p[0];
          job.aggregated_verdict = p[1];
          job.aggregated_risk_level = p[2];
          return Promise.resolve({ rows: [job], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // INSERT INTO alerts
      if (sql.startsWith('insert into alerts')) {
        const newAlert = {
          id: `alert-${mockAlerts.length + 1}`,
          org_id: p[0],
          job_id: p[1],
          result_id: p[2],
          severity: p[3],
          title: p[4],
          summary: p[5],
          resolved_by: null,
          resolved_at: null,
        };
        mockAlerts.push(newAlert);
        return Promise.resolve({ rows: [newAlert], rowCount: 1 });
      }

      // UPDATE alerts
      if (sql.startsWith('update alerts')) {
        // Resolve alert
        const resolvedBy = p[0];
        const resultId = p[1];
        const jobId = p[2];
        const alertsToResolve = mockAlerts.filter(
          (a) => (a.result_id === resultId || a.job_id === jobId) && !a.resolved_at,
        );
        alertsToResolve.forEach((a) => {
          a.resolved_by = resolvedBy;
          a.resolved_at = new Date();
        });
        return Promise.resolve({ rows: alertsToResolve, rowCount: alertsToResolve.length });
      }

      // INSERT INTO audit_logs
      if (sql.startsWith('insert into audit_logs')) {
        mockAuditLogs.push(p);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      // COUNT reviews stats query
      if (sql.startsWith('select count(*)::int')) {
        let count = 0;
        if (sql.includes("status = 'pending'"))
          count = mockReviews.filter((r) => r.status === 'pending').length;
        else if (sql.includes("status = 'assigned'"))
          count = mockReviews.filter((r) => r.status === 'assigned').length;
        else if (sql.includes("status = 'in_review'"))
          count = mockReviews.filter((r) => r.status === 'in_review').length;
        else if (sql.includes('sla_deadline < now()')) {
          count = mockReviews.filter(
            (r) =>
              r.sla_deadline < new Date() &&
              !['completed', 'auto_resolved', 'escalated'].includes(r.status),
          ).length;
        }
        return Promise.resolve({ rows: [{ count }], rowCount: 1 });
      }

      // AVG hours completed reviews query
      if (sql.includes('avg_hours')) {
        const completed = mockReviews.filter((r) => r.status === 'completed');
        const avg = completed.length > 0 ? 1.5 : 0; // Simple mock avg resolution time of 1.5 hours
        return Promise.resolve({ rows: [{ avg_hours: avg }], rowCount: 1 });
      }

      // Per analyst workloads counts query
      if (sql.includes('select u.id as reviewer_id')) {
        const rows = mockUsers
          .filter((u) => ['analyst', 'admin'].includes(u.role))
          .map((u) => {
            const activeCount = mockReviews.filter(
              (r) => r.assigned_to === u.id && ['assigned', 'in_review'].includes(r.status),
            ).length;
            return {
              reviewer_id: u.id,
              reviewer_email: u.email,
              active_count: activeCount,
            };
          });
        return Promise.resolve({ rows, rowCount: rows.length });
      }

      return Promise.resolve({ rows: [], rowCount: 0 });
    }) as any),
  };
});

// Mock Redis
jest.mock('../src/shared/redis/index.js', () => {
  return {
    checkRedisHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
    redis: {
      get: jest
        .fn()
        .mockImplementation(((key: any) => Promise.resolve(mockRedisStore[key] || null)) as any),
      set: jest.fn().mockImplementation(((key: any, value: any) => {
        mockRedisStore[key] = value;
        return Promise.resolve('OK');
      }) as any),
      del: jest.fn().mockImplementation(((key: any) => {
        delete mockRedisStore[key];
        return Promise.resolve(1);
      }) as any),
    },
  };
});

jest.mock('../src/shared/redis/redis.client.js', () => ({
  redisClient: {
    get: jest
      .fn()
      .mockImplementation(((key: any) => Promise.resolve(mockRedisStore[key] || null)) as any),
    setex: jest.fn().mockImplementation(((key: any, _ttl: any, val: any) => {
      mockRedisStore[key] = val;
      return Promise.resolve('OK');
    }) as any),
    del: jest.fn().mockImplementation(((key: any) => {
      delete mockRedisStore[key];
      return Promise.resolve(1);
    }) as any),
    keys: jest.fn().mockImplementation((() => Promise.resolve(Object.keys(mockRedisStore))) as any),
    incr: jest.fn().mockImplementation((() => Promise.resolve(1)) as any),
    expire: jest.fn().mockImplementation((() => Promise.resolve(1)) as any),
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
        const val = parseInt(mockRedisStore[key] || '0', 10) + 1;
        mockRedisStore[key] = val.toString();
        return Promise.resolve([val, 60]);
      }
      return Promise.resolve();
    }) as any),
    on: jest.fn(),
  },
  isRedisHealthy: jest.fn().mockImplementation(() => Promise.resolve(true)),
}));

jest.mock('../src/shared/redis/cache.service.js', () => ({
  cacheService: {
    getOrSet: jest
      .fn()
      .mockImplementation(((_key: any, _ttl: any, fetchFn: any) => fetchFn()) as any),
    invalidateOrgCache: jest.fn().mockImplementation(() => Promise.resolve()),
  },
}));

// Load Service and App
import { ReviewService } from '../src/modules/review/review.service.js';
import { app } from '../src/app.js';

function signMockToken(userId: string, role: string, orgId: string) {
  return jwt.sign({ userId, role, orgId }, env.JWT_SECRET || 'test-secret', { expiresIn: '1h' });
}

describe('Human Review Queue & Operations Suite', () => {
  beforeEach(() => {
    resetMockState();
  });

  describe('ReviewService shouldTriggerHumanReview Checks', () => {
    it('should return true for score within the ambiguous range (40 - 70)', () => {
      expect(ReviewService.shouldTriggerHumanReview(55)).toBe(true);
      expect(ReviewService.shouldTriggerHumanReview(40)).toBe(true);
      expect(ReviewService.shouldTriggerHumanReview(70)).toBe(true);
    });

    it('should return false for score outside ambiguous range', () => {
      expect(ReviewService.shouldTriggerHumanReview(25)).toBe(false);
      expect(ReviewService.shouldTriggerHumanReview(80)).toBe(false);
    });

    it('should return true if any result verdict is requires_review', () => {
      const results = [{ verdict: 'requires_review', score: 20 } as any];
      expect(ReviewService.shouldTriggerHumanReview(20, results)).toBe(true);
    });

    it('should return true if there is a conflict in verdicts', () => {
      const results = [
        { verdict: 'clean', score: 10 } as any,
        { verdict: 'manipulated', score: 90 } as any,
      ];
      expect(ReviewService.shouldTriggerHumanReview(50, results)).toBe(true);
    });
  });

  describe('ReviewService Tasks Orchestration', () => {
    const mockResult = { id: 'res-1', score: 65, verdict: 'suspicious' } as any;
    const mockJob = { id: 'job-1', org_id: 'org-uuid-1' } as any;

    it('should successfully create a review task with correct defaults', async () => {
      const review = await ReviewService.createReviewTask(mockResult, mockJob);
      expect(review.status).toBe('pending');
      expect(review.priority).toBe('high'); // score > 60
      expect(review.ai_score).toBe(65);
      expect(mockReviews.length).toBe(1);
    });

    it('should determine priority based on org plan tier (enterprise -> urgent)', async () => {
      const enterpriseJob = { id: 'job-ent', org_id: 'org-uuid-3' } as any;
      const review = await ReviewService.createReviewTask(
        { id: 'res-2', score: 20, verdict: 'clean' } as any,
        enterpriseJob,
      );
      expect(review.priority).toBe('urgent');
    });

    it('should successfully assign a task to an analyst', async () => {
      const review = await ReviewService.createReviewTask(mockResult, mockJob);
      const assigned = await ReviewService.assignReview(review.id, 'user-analyst');

      expect(assigned.assigned_to).toBe('user-analyst');
      expect(assigned.status).toBe('assigned');
      expect(mockAuditLogs.length).toBe(1);
    });

    it('should reject assignment if analyst workload exceeds 10 active tasks', async () => {
      // Setup mock reviews for analyst
      for (let i = 0; i < 10; i++) {
        mockReviews.push({
          id: `rev-active-${i}`,
          org_id: 'org-uuid-1',
          assigned_to: 'user-analyst',
          status: 'assigned',
        });
      }

      const review = await ReviewService.createReviewTask(mockResult, mockJob);
      await expect(ReviewService.assignReview(review.id, 'user-analyst')).rejects.toThrow(
        'Analyst has reached the maximum workload limit',
      );
    });

    it('should successfully submit review and aggregate results with human_review_override flag', async () => {
      const review = await ReviewService.createReviewTask(mockResult, mockJob);
      await ReviewService.assignReview(review.id, 'user-analyst');
      await ReviewService.startReview(review.id, 'user-analyst');

      // Setup detection results in mock state
      const targetResult = {
        id: 'res-1',
        job_id: 'job-1',
        module: 'deepfake',
        score: 65,
        verdict: 'suspicious',
        flags: [],
      };
      mockResults.push(targetResult);

      const jobRecord = {
        id: 'job-1',
        org_id: 'org-uuid-1',
        aggregated_score: 65,
        aggregated_verdict: 'suspicious',
      };
      mockJobs.push(jobRecord);

      const completed = await ReviewService.submitReview(review.id, 'user-analyst', {
        reviewerVerdict: 'manipulated',
        reviewerNotes: 'This is indeed manipulated',
        reviewerConfidence: 5,
        overrideReason: 'Found deepfake artifacts',
      });

      expect(completed.status).toBe('completed');
      expect(completed.reviewer_verdict).toBe('manipulated');
      expect(targetResult.verdict).toBe('manipulated');
      expect(targetResult.flags).toContain('human_review_override');
      expect(mockJobs[0].aggregated_verdict).toBe('manipulated');
    });

    it('should auto-resolve overdue tasks past SLA deadline with original AI verdict', async () => {
      const pastDeadline = new Date();
      pastDeadline.setHours(pastDeadline.getHours() - 5);

      mockReviews.push({
        id: 'review-overdue',
        result_id: 'res-overdue',
        job_id: 'job-overdue',
        org_id: 'org-uuid-1',
        ai_score: 55,
        ai_verdict: 'suspicious',
        status: 'pending',
        sla_deadline: pastDeadline,
      });

      const count = await ReviewService.autoResolveExpiredReviews();
      expect(count).toBe(1);
      expect(mockReviews[0].status).toBe('auto_resolved');
      expect(mockReviews[0].reviewer_verdict).toBe('suspicious');
      expect(mockReviews[0].override_reason).toBe('auto_resolved_sla_breach');
      expect(mockAlerts.length).toBe(1); // SLA breach alert generated
    });
  });

  describe('API Endpoints - Route & Roles Enforcement', () => {
    it('GET /reviews should reject unauthorized roles', async () => {
      const userToken = signMockToken('user-regular', 'user', 'org-uuid-1');
      await request(app)
        .get('/api/v1/reviews')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(403);
    });

    it('GET /reviews should return lists for admin or analyst', async () => {
      const analystToken = signMockToken('user-analyst', 'analyst', 'org-uuid-1');
      mockReviews.push({
        id: 'r1',
        org_id: 'org-uuid-1',
        status: 'pending',
        priority: 'high',
        sla_deadline: new Date(),
      });

      const res = await request(app)
        .get('/api/v1/reviews')
        .set('Authorization', `Bearer ${analystToken}`)
        .expect(200);

      expect(res.body.reviews).toBeDefined();
      expect(res.body.reviews.length).toBe(1);
    });

    it('GET /reviews/stats should reject non-admin users', async () => {
      const analystToken = signMockToken('user-analyst', 'analyst', 'org-uuid-1');
      await request(app)
        .get('/api/v1/reviews/stats')
        .set('Authorization', `Bearer ${analystToken}`)
        .expect(403);
    });

    it('GET /reviews/stats should return dashboard summary for admins', async () => {
      const adminToken = signMockToken('user-admin', 'admin', 'org-uuid-1');
      const res = await request(app)
        .get('/api/v1/reviews/stats')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.pending).toBeDefined();
      expect(res.body.overdueCount).toBeDefined();
      expect(res.body.reviewerWorkloads).toBeDefined();
    });

    it('POST /reviews/:id/assign should allow analysts self-assignment', async () => {
      const analystToken = signMockToken('user-analyst', 'analyst', 'org-uuid-1');
      const review = {
        id: 'rev-assign-1',
        org_id: 'org-uuid-1',
        status: 'pending',
        job_id: 'j1',
        result_id: 'res1',
      };
      mockReviews.push(review);

      const res = await request(app)
        .post(`/api/v1/reviews/${review.id}/assign`)
        .set('Authorization', `Bearer ${analystToken}`)
        .send({ analystUserId: 'user-analyst' })
        .expect(200);

      expect(res.body.assigned_to).toBe('user-analyst');
      expect(res.body.status).toBe('assigned');
    });

    it('POST /reviews/:id/assign should reject analysts assigning to others', async () => {
      const analystToken = signMockToken('user-analyst', 'analyst', 'org-uuid-1');
      const review = {
        id: 'rev-assign-2',
        org_id: 'org-uuid-1',
        status: 'pending',
        job_id: 'j1',
        result_id: 'res1',
      };
      mockReviews.push(review);

      await request(app)
        .post(`/api/v1/reviews/${review.id}/assign`)
        .set('Authorization', `Bearer ${analystToken}`)
        .send({ analystUserId: 'user-regular' })
        .expect(403);
    });
  });
});
