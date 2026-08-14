/* eslint-disable @typescript-eslint/ban-ts-comment */
import request from 'supertest';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

// --- Local Mock DB State ---
let mockJobs: any[] = [];
let mockResults: any[] = [];

// --- Mock Database and Redis pool ---
jest.mock('../src/shared/database/index.js', () => {
  return {
    checkDatabaseHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
    query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
  };
});

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

      // 1. SELECT * FROM detection_jobs WHERE id = $1 AND org_id = $2
      if (sql.startsWith('select * from detection_jobs where id = $1 and org_id = $2')) {
        const id = p[0];
        const orgId = p[1];
        const job = mockJobs.find((j) => j.id === id && j.org_id === orgId) || null;
        return Promise.resolve({ rows: job ? [job] : [], rowCount: job ? 1 : 0 });
      }

      // 2. SELECT * FROM detection_jobs WHERE id = $1
      if (sql.startsWith('select * from detection_jobs where id = $1') && !sql.includes('org_id')) {
        const id = p[0];
        const job = mockJobs.find((j) => j.id === id) || null;
        return Promise.resolve({ rows: job ? [job] : [], rowCount: job ? 1 : 0 });
      }

      // 3. SELECT * FROM detection_results WHERE job_id = $1 AND org_id = $2
      if (sql.startsWith('select * from detection_results where job_id = $1 and org_id = $2')) {
        const jobId = p[0];
        const orgId = p[1];
        const filtered = mockResults.filter((r) => r.job_id === jobId && r.org_id === orgId);
        return Promise.resolve({ rows: filtered, rowCount: filtered.length });
      }

      // 4. INSERT INTO detection_jobs
      if (sql.startsWith('insert into detection_jobs')) {
        // org_id ($1), created_by ($2), content_type ($3), detection_modules ($4), priority ($5), source_url ($6)
        const orgId = p[0];
        const userId = p[1];
        const contentType = p[2];
        const detectionModules = p[3];
        const priority = p[4];
        const sourceUrl = p[5];

        const newJob = {
          id: `job-uuid-${Math.random().toString(36).substr(2, 9)}`,
          org_id: orgId,
          created_by: userId,
          content_type: contentType,
          detection_modules: detectionModules,
          status: 'pending',
          priority,
          s3_key: null,
          source_url: sourceUrl || null,
          source_metadata: {},
          error_message: null,
          retry_count: 0,
          max_retries: 3,
          queued_at: null,
          started_at: null,
          completed_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        };

        mockJobs.push(newJob);
        return Promise.resolve({ rows: [newJob], rowCount: 1 });
      }

      // 5. UPDATE detection_jobs
      if (sql.startsWith('update detection_jobs')) {
        // status ($1), extras... [params.length - 1] is jobId
        const status = p[0];
        const jobId = p[p.length - 1];
        const job = mockJobs.find((j) => j.id === jobId);

        if (job) {
          job.status = status;
          job.updated_at = new Date();
          if (status === 'queued') job.queued_at = new Date();
          if (status === 'processing') job.started_at = new Date();
          if (status === 'completed' || status === 'failed' || status === 'cancelled') {
            job.completed_at = new Date();
          }
          return Promise.resolve({ rows: [job], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // 6. COUNT pagination
      if (sql.startsWith('select count(*) as total from detection_jobs')) {
        const orgId = p[0];
        let filtered = mockJobs.filter((j) => j.org_id === orgId);

        if (sql.includes('status = $2')) {
          filtered = filtered.filter((j) => j.status === p[1]);
        } else if (sql.includes('content_type = $2')) {
          filtered = filtered.filter((j) => j.content_type === p[1]);
        }
        return Promise.resolve({ rows: [{ total: filtered.length.toString() }], rowCount: 1 });
      }

      // 7. SELECT list jobs (with pagination)
      if (
        sql.startsWith('select * from detection_jobs where org_id = $1') ||
        sql.includes('from detection_jobs j')
      ) {
        const orgId = p[0];
        let filtered = [...mockJobs].filter((j) => j.org_id === orgId);

        if (sql.includes('status = $2')) {
          filtered = filtered.filter((j) => j.status === p[1]);
        } else if (sql.includes('content_type = $2')) {
          filtered = filtered.filter((j) => j.content_type === p[1]);
        }

        // Apply simple ordering, limit, offset
        filtered.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

        // Locate limit/offset in parameters (always the last two parameters)
        const limit = p[p.length - 2];
        const offset = p[p.length - 1];
        const sliced = filtered.slice(offset, offset + limit);

        return Promise.resolve({ rows: sliced, rowCount: sliced.length });
      }

      return Promise.resolve({ rows: [], rowCount: 0 });
    }) as any),
    transaction: jest.fn().mockImplementation(((callback: any) => {
      const mockClient = {
        query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
      };
      return callback(mockClient as any);
    }) as any),
  };
});

jest.mock('../src/shared/redis/index.js', () => {
  return {
    checkRedisHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
    redis: {
      get: jest.fn().mockImplementation(() => Promise.resolve(null)),
      set: jest.fn().mockImplementation(() => Promise.resolve('OK')),
      del: jest.fn().mockImplementation(() => Promise.resolve(1)),
    },
  };
});

jest.mock('../src/shared/redis/redis.client.js', () => ({
  redisClient: {
    get: jest.fn().mockImplementation(() => Promise.resolve(null)),
    setex: jest.fn().mockImplementation(() => Promise.resolve('OK')),
    del: jest.fn().mockImplementation(() => Promise.resolve(1)),
    keys: jest.fn().mockImplementation(() => Promise.resolve([])),
    incr: jest.fn().mockImplementation(() => Promise.resolve(1)),
    expire: jest.fn().mockImplementation(() => Promise.resolve(1)),
    ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
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
}));

// Import service, model and app to test
import { JobModel } from '../src/modules/jobs/job.model.js';
import { app } from '../src/app.js';

describe('Detection Job Management & Scopes Suite', () => {
  const orgId = 'org-uuid-test';
  const userId = 'user-uuid-123';

  const accessToken = jwt.sign({ userId, orgId, role: 'admin' }, env.JWT_SECRET, {
    expiresIn: '15m',
  });

  const analystToken = jwt.sign({ userId, orgId, role: 'analyst' }, env.JWT_SECRET, {
    expiresIn: '15m',
  });

  beforeEach(() => {
    mockJobs = [];
    mockResults = [];
  });

  describe('JobModel DB Queries & Schema Alignment Checks', () => {
    it('should successfully create a pending job and insert the correct record', async () => {
      const job = await JobModel.createJob(orgId, userId, {
        contentType: 'image',
        detectionModules: ['deepfake'],
        priority: 8,
      });

      expect(job.org_id).toBe(orgId);
      expect(job.created_by).toBe(userId);
      expect(job.content_type).toBe('image');
      expect(job.detection_modules).toContain('deepfake');
      expect(job.status).toBe('pending');
      expect(job.priority).toBe(8);
      expect(job.s3_key).toBeNull();
    });

    it('should reject deepfake module validation for article contentType and throw ValidationError', async () => {
      await expect(
        JobModel.createJob(orgId, userId, {
          contentType: 'article',
          detectionModules: ['deepfake'],
          sourceUrl: 'https://truthshield.ai/news/article-1',
        }),
      ).rejects.toThrow("Module 'deepfake' is only compatible with 'video' or 'image'");
    });

    it('should retrieve job scoped strictly under authorized orgId and return null for unauthorized org', async () => {
      const job = await JobModel.createJob(orgId, userId, {
        contentType: 'video',
        detectionModules: ['deepfake'],
      });

      // Valid lookup
      const found = await JobModel.getJobById(job.id, orgId);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(job.id);

      // Unauthorized lookup (different organization partition)
      const foreign = await JobModel.getJobById(job.id, 'foreign-org-id');
      expect(foreign).toBeNull();
    });

    it('should correctly transition status state pending -> queued -> processing -> completed and set timestamps', async () => {
      const job = await JobModel.createJob(orgId, userId, {
        contentType: 'image',
        detectionModules: ['deepfake'],
      });

      // 1. Transition pending -> queued
      let updated = await JobModel.updateJobStatus(job.id, 'queued');
      expect(updated.status).toBe('queued');
      expect(updated.queued_at).not.toBeNull();

      // 2. Transition queued -> processing
      updated = await JobModel.updateJobStatus(job.id, 'processing');
      expect(updated.status).toBe('processing');
      expect(updated.started_at).not.toBeNull();

      // 3. Transition processing -> completed
      updated = await JobModel.updateJobStatus(job.id, 'completed');
      expect(updated.status).toBe('completed');
      expect(updated.completed_at).not.toBeNull();
    });

    it('should block illegal status transitions and throw ValidationError', async () => {
      const job = await JobModel.createJob(orgId, userId, {
        contentType: 'image',
        detectionModules: ['deepfake'],
      });

      // Try transition completed -> pending directly
      await JobModel.updateJobStatus(job.id, 'queued');
      await JobModel.updateJobStatus(job.id, 'processing');
      await JobModel.updateJobStatus(job.id, 'completed');

      await expect(JobModel.updateJobStatus(job.id, 'pending')).rejects.toThrow(
        "Invalid job status transition from 'completed' to 'pending'",
      );
    });

    it('should correctly query and paginate organization jobs with page and totals', async () => {
      // Seed mockJobs with 15 records
      for (let i = 0; i < 15; i++) {
        await JobModel.createJob(orgId, userId, {
          contentType: 'url',
          detectionModules: ['fake_news'],
          sourceUrl: `https://truthshield.ai/leak-${i}`,
        });
      }

      // Page 1 with limit 10
      const page1 = await JobModel.getJobsByOrg(orgId, { page: 1, limit: 10 });
      expect(page1.jobs.length).toBe(10);
      expect(page1.total).toBe(15);
      expect(page1.page).toBe(1);

      // Page 2 with limit 10
      const page2 = await JobModel.getJobsByOrg(orgId, { page: 2, limit: 10 });
      expect(page2.jobs.length).toBe(5);
      expect(page2.total).toBe(15);
      expect(page2.page).toBe(2);
    });
  });

  describe('Job REST Routes Integration Tests', () => {
    it('POST /api/v1/jobs should create job and return upload instructions for image uploads', async () => {
      const res = await request(app)
        .post('/api/v1/jobs')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          contentType: 'image',
          detectionModules: ['deepfake'],
          priority: 5,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.uploadRequired).toBe(true);
      expect(res.body.uploadInstructions.method).toBe('POST');
      expect(res.body.uploadInstructions.url).toBe('/api/v1/uploads/presign');
    });

    it('POST /api/v1/jobs should create url job and immediately progress to queued', async () => {
      const res = await request(app)
        .post('/api/v1/jobs')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          contentType: 'url',
          detectionModules: ['fake_news'],
          sourceUrl: 'https://truthshield.ai/reports/leak.html',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.uploadRequired).toBe(false);
      expect(res.body.job.status).toBe('queued');
    });

    it('POST /api/v1/jobs/:id/cancel should cancel job, and block cancellation on completed jobs', async () => {
      const job = await JobModel.createJob(orgId, userId, {
        contentType: 'image',
        detectionModules: ['deepfake'],
      });

      // 1. Cancel pending job
      const cancelRes = await request(app)
        .post(`/api/v1/jobs/${job.id}/cancel`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.job.status).toBe('cancelled');

      // 2. Set job to completed directly to check block
      const completedJob = await JobModel.createJob(orgId, userId, {
        contentType: 'image',
        detectionModules: ['deepfake'],
      });
      await JobModel.updateJobStatus(completedJob.id, 'queued');
      await JobModel.updateJobStatus(completedJob.id, 'processing');
      await JobModel.updateJobStatus(completedJob.id, 'completed');

      const failedCancelRes = await request(app)
        .post(`/api/v1/jobs/${completedJob.id}/cancel`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(failedCancelRes.status).toBe(400);
      expect(failedCancelRes.body.error.message).toContain(
        'Cannot cancel a job that is already in',
      );
    });

    it('DELETE /api/v1/jobs/:id should support soft deletion by authorized analysts and admins', async () => {
      const job = await JobModel.createJob(orgId, userId, {
        contentType: 'image',
        detectionModules: ['deepfake'],
      });

      const delRes = await request(app)
        .delete(`/api/v1/jobs/${job.id}`)
        .set('Authorization', `Bearer ${analystToken}`);

      expect(delRes.status).toBe(200);
      expect(delRes.body.success).toBe(true);

      const checkJob = await JobModel.getJobById(job.id, orgId);
      expect(checkJob?.status).toBe('cancelled');
    });
  });
});
