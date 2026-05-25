/* eslint-disable @typescript-eslint/ban-ts-comment */
import { jest } from '@jest/globals';
import request from 'supertest';

// --- Local Mock DB State ---
let mockJobs: any[] = [];
let mockResults: any[] = [];
let mockAlerts: any[] = [];

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

      // 1. SELECT * FROM detection_jobs WHERE id = $1
      if (sql.includes('select * from detection_jobs') && sql.includes('id = $1')) {
        const id = p[0];
        const job = mockJobs.find((j) => j.id === id) || null;
        return Promise.resolve({ rows: job ? [job] : [], rowCount: job ? 1 : 0 });
      }

      // 2. INSERT INTO detection_results
      if (sql.includes('insert into detection_results')) {
        const newResult = {
          id: `res-uuid-${Math.random()}`,
          job_id: p[0],
          org_id: p[1],
          module: p[2],
          score: p[3],
          verdict: p[4],
          confidence: p[5],
          model_version: p[6],
          result_data: JSON.parse(p[7]),
          flags: p[8],
          created_at: new Date(),
        };
        mockResults.push(newResult);
        return Promise.resolve({ rows: [newResult], rowCount: 1 });
      }

      // 3. INSERT INTO alerts
      if (sql.includes('insert into alerts')) {
        const newAlert = {
          id: `alert-uuid-${Math.random()}`,
          org_id: p[0],
          job_id: p[1],
          type: 'job_failure',
          severity: 'critical',
          status: 'open',
          message: p[2],
          metadata: JSON.parse(p[3]),
        };
        mockAlerts.push(newAlert);
        return Promise.resolve({ rows: [newAlert], rowCount: 1 });
      }

      // 4. UPDATE retry_count
      if (sql.includes('update') && sql.includes('retry_count')) {
        const jobId = p[0];
        const job = mockJobs.find((j) => j.id === jobId);
        if (job) {
          job.retry_count += 1;
          return Promise.resolve({
            rows: [{ retry_count: job.retry_count, max_retries: job.max_retries, org_id: job.org_id }],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // 5. General UPDATE
      else if (sql.includes('update') && sql.includes('detection_jobs')) {
        const status = p[0];
        const jobId = p[p.length - 1];
        const job = mockJobs.find((j) => j.id === jobId);
        if (job) {
          job.status = status;
          return Promise.resolve({ rows: [job], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      return Promise.resolve({ rows: [], rowCount: 0 });
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

// --- Mock BullMQ queue structures ---
const mockQueueAdd = jest.fn();
jest.mock('bullmq', () => {
  return {
    Queue: jest.fn().mockImplementation((...args: any[]) => {
      const name = args[0];
      return {
        name,
        add: mockQueueAdd.mockImplementation((_jobName: any, data: any, opts: any) => {
          return Promise.resolve({ id: opts?.jobId || 'mock-job-id', data, opts });
        }),
        getJobCounts: jest.fn().mockImplementation(() => Promise.resolve({ waiting: 0 })),
        on: jest.fn(),
      };
    }),
    QueueEvents: jest.fn().mockImplementation(() => {
      return {
        on: jest.fn(),
      };
    }),
    Worker: jest.fn().mockImplementation((...args: any[]) => {
      const name = args[0];
      const processor = args[1];
      const opts = args[2];
      return {
        name,
        processor,
        opts,
        on: jest.fn(),
      };
    }),
  };
});

jest.mock('@bull-board/api/bullMQAdapter', () => {
  return {
    BullMQAdapter: jest.fn().mockImplementation((queue: any) => {
      return {
        queue,
      };
    }),
  };
});

// Import services and dispatcher
import { addDetectionJob } from '../src/shared/queue/queues.js';
import { DetectionWorker } from '../src/shared/queue/detection.worker.js';
import { dispatchJob } from '../src/modules/jobs/job.dispatcher.js';
import { app } from '../src/app.js';

describe('Job Queue Infrastructure Suite', () => {
  const orgId = 'org-uuid-test';
  const jobId = 'job-uuid-123';
  const userId = 'user-uuid-123';

  beforeEach(() => {
    mockJobs = [
      {
        id: jobId,
        org_id: orgId,
        created_by: userId,
        content_type: 'image',
        detection_modules: ['deepfake'],
        status: 'pending',
        priority: 5,
        s3_key: null,
        source_url: null,
        source_metadata: {},
        retry_count: 0,
        max_retries: 3,
      },
    ];
    mockResults = [];
    mockAlerts = [];
    mockQueueAdd.mockClear();
  });

  describe('BullMQ Queue Helper Checks', () => {
    it('addDetectionJob should successfully add a job payload to detectionQueue with correct options', async () => {
      await addDetectionJob(jobId, orgId, { modules: ['deepfake'] }, 8);

      expect(mockQueueAdd).toHaveBeenCalled();
      const args = mockQueueAdd.mock.calls[0] as any[];
      
      expect(args[0]).toBe('detection-task');
      expect(args[1].jobId).toBe(jobId);
      expect(args[1].orgId).toBe(orgId);
      expect(args[1].modules).toContain('deepfake');
      expect(args[2].jobId).toBe(jobId);
      expect(args[2].priority).toBe(8);
    });
  });

  describe('Job Dispatcher Checks', () => {
    it('dispatchJob should reject non-pending jobs with a ValidationError', async () => {
      const completedJob = {
        ...mockJobs[0],
        status: 'completed',
      };

      await expect(
        dispatchJob(completedJob as any)
      ).rejects.toThrow("Only pending jobs can be dispatched to queue");
    });

    it('dispatchJob should successfully add job to BullMQ queue and transition DB status to queued', async () => {
      const job = mockJobs[0];
      await dispatchJob(job as any);

      expect(mockQueueAdd).toHaveBeenCalled();
      expect(job.status).toBe('queued');
    });
  });

  describe('DetectionWorker Processing Checks', () => {
    it('Worker should execute modules, create database records, and update status to completed', async () => {
      const worker = new DetectionWorker();
      mockJobs[0].status = 'queued';
      
      const mockJob = {
        id: jobId,
        data: {
          jobId,
          orgId,
          detectionModules: ['deepfake', 'metadata_tampering'],
        },
      };

      await worker.process(mockJob as any);

      // 1. Check status is updated to completed
      const job = mockJobs.find((j) => j.id === jobId);
      expect(job?.status).toBe('completed');

      // 2. Check results are saved
      expect(mockResults.length).toBe(2);
      expect(mockResults[0].module).toBe('deepfake');
      expect(mockResults[0].score).toBe(85);
      expect(mockResults[1].module).toBe('metadata_tampering');
      expect(mockResults[1].score).toBe(5);

      // 3. Confirm alert is added since deepfake score (85) exceeds 60 threshold
      expect(mockQueueAdd).toHaveBeenCalled();
      const calls = mockQueueAdd.mock.calls;
      const alertQueueCall = calls.find((c) => c[0] === 'send-notifications');
      expect(alertQueueCall).toBeDefined();
    });
  });

  describe('Worker Error Handling & Retries Checks', () => {
    it('handleFailure should increment retry_count on transient errors', async () => {
      const worker = new DetectionWorker();
      const error = new Error('Transient network timeout');
      mockJobs[0].status = 'processing';

      const mockJob = {
        id: jobId,
      };

      // @ts-ignore
      await worker.handleFailure(mockJob as any, error);

      const job = mockJobs.find((j) => j.id === jobId);
      expect(job?.retry_count).toBe(1);
      expect(job?.status).not.toBe('failed'); // Not failed yet since retry_count (1) < max_retries (3)
    });

    it('handleFailure should mark job as failed and dispatch a critical alert at maximum retry attempts', async () => {
      const worker = new DetectionWorker();
      const error = new Error('Unrecoverable pipeline crash');

      const job = mockJobs.find((j) => j.id === jobId);
      if (job) {
        job.status = 'processing';
        job.retry_count = 2; // Sets it such that the incremented count (3) reaches max_retries (3)
      }

      const mockJob = {
        id: jobId,
      };

      // @ts-ignore
      await worker.handleFailure(mockJob as any, error);

      expect(job?.retry_count).toBe(3);
      expect(job?.status).toBe('failed');

      // Verify that a critical notification alert was written to the DB
      expect(mockAlerts.length).toBe(1);
      expect(mockAlerts[0].type).toBe('job_failure');
      expect(mockAlerts[0].severity).toBe('critical');
      expect(mockAlerts[0].message).toContain('failed after maximum retry threshold');
    });
  });

  describe('Bull Board Authorization Integration Tests', () => {
    it('GET /admin/queues should return 401 if X-Admin-Secret header is incorrect or missing', async () => {
      const res = await request(app)
        .get('/admin/queues');

      expect(res.status).toBe(401);
    });

    it('GET /admin/queues should bypass authorization check and load router if correct X-Admin-Secret is provided', async () => {
      const res = await request(app)
        .get('/admin/queues')
        .set('x-admin-secret', 'admin-secret-key-12345');

      // The router itself will respond with a 200 or 302 redirect
      expect(res.status).not.toBe(401);
    });
  });
});
