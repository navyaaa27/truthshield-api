/* eslint-disable @typescript-eslint/ban-ts-comment */
import request from 'supertest';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

// --- AWS S3 SDK Mocking ---
jest.mock('@aws-sdk/client-s3', () => {
  return {
    S3Client: jest.fn().mockImplementation(() => {
      return {
        send: jest.fn().mockImplementation((command: any) => {
          const key = command.input?.Key;
          if (command.constructor.name === 'HeadObjectCommand' || command.name === 'HeadObjectCommand') {
            if (key === 'non-existent-key' || key?.includes('non-existent')) {
              const err = new Error('NotFound');
              err.name = 'NotFound';
              return Promise.reject(err);
            }
            return Promise.resolve({
              ContentType: command.input?.ContentType || 'image/png',
              ContentLength: 2048,
            });
          }
          return Promise.resolve({});
        }),
      };
    }),
    PutObjectCommand: jest.fn().mockImplementation((input) => ({ constructor: { name: 'PutObjectCommand' }, input })),
    GetObjectCommand: jest.fn().mockImplementation((input) => ({ constructor: { name: 'GetObjectCommand' }, input })),
    HeadObjectCommand: jest.fn().mockImplementation((input) => ({ constructor: { name: 'HeadObjectCommand' }, input })),
    DeleteObjectCommand: jest.fn().mockImplementation((input) => ({ constructor: { name: 'DeleteObjectCommand' }, input })),
    CopyObjectCommand: jest.fn().mockImplementation((input) => ({ constructor: { name: 'CopyObjectCommand' }, input })),
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => {
  return {
    getSignedUrl: jest.fn().mockImplementation(() => {
      return Promise.resolve('https://s3.amazonaws.com/mock-signed-url');
    }),
  };
});

// --- Database & Redis Mocking ---
let mockJobs: any[] = [];
let mockAuditLogs: any[] = [];

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

      if (sql.startsWith('insert into audit_logs')) {
        mockAuditLogs.push(p);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      if (sql.startsWith('select') && sql.includes('detection_jobs')) {
        const jobId = p[0];
        const orgId = p[1];
        const job = mockJobs.find((j) => j.id === jobId && j.org_id === orgId);
        if (job) {
          return Promise.resolve({ rows: [job], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      if (sql.startsWith('update detection_jobs')) {
        // p = [s3Key, metadataPatch, jobId, orgId]
        const s3Key = p[0];
        const metadataPatch = JSON.parse(p[1]);
        const jobId = p[2];
        const orgId = p[3];

        const job = mockJobs.find((j) => j.id === jobId && j.org_id === orgId);
        if (job) {
          job.s3_key = s3Key;
          job.source_metadata = { ...job.source_metadata, ...metadataPatch };
          return Promise.resolve({ rows: [job], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
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

// Import service & app to test
import { S3Service, sanitizeFileName } from '../src/shared/storage/s3.service.js';
import { app } from '../src/app.js';

describe('AWS S3 File Storage & Presigning Service Tests', () => {
  const orgId = 'org-uuid-test';
  const jobId = 'job-uuid-123';
  const userId = 'user-uuid-123';

  // Issue a valid JWT access token for authentication
  const accessToken = jwt.sign(
    { userId, orgId, role: 'admin' },
    env.JWT_SECRET,
    { expiresIn: '15m' }
  );

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
        source_metadata: {},
      },
    ];
    mockAuditLogs = [];
  });

  describe('S3Service Presigned URL Generation Checks', () => {
    it('should successfully generate pre-signed upload URL for allowed mimetypes', async () => {
      const res = await S3Service.getPresignedUploadUrl({
        orgId,
        jobId,
        fileName: 'face_analysis.png',
        mimeType: 'image/png',
        fileSizeBytes: 1024 * 1024, // 1MB
      });

      expect(res.uploadUrl).toBe('https://s3.amazonaws.com/mock-signed-url');
      expect(res.s3Key).toContain(`${orgId}/jobs/${jobId}/`);
      expect(res.s3Key).toContain('face_analysis.png');
      expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('should reject disallowed mime types and throw ValidationError', async () => {
      await expect(
        S3Service.getPresignedUploadUrl({
          orgId,
          jobId,
          fileName: 'malicious.exe',
          mimeType: 'application/x-msdownload',
          fileSizeBytes: 2048,
        })
      ).rejects.toThrow('Unsupported file type');
    });

    it('should reject files exceeding size limits per media type', async () => {
      // 51MB image should fail (limit is 50MB)
      await expect(
        S3Service.getPresignedUploadUrl({
          orgId,
          jobId,
          fileName: 'huge_image.png',
          mimeType: 'image/png',
          fileSizeBytes: 51 * 1024 * 1024,
        })
      ).rejects.toThrow('File size exceeds the allowed limit');

      // 501MB video should fail (limit is 500MB)
      await expect(
        S3Service.getPresignedUploadUrl({
          orgId,
          jobId,
          fileName: 'huge_video.mp4',
          mimeType: 'video/mp4',
          fileSizeBytes: 501 * 1024 * 1024,
        })
      ).rejects.toThrow('File size exceeds the allowed limit');
    });

    it('should ensure s3Key always starts with orgId as the first path segment', async () => {
      const res = await S3Service.getPresignedUploadUrl({
        orgId,
        jobId,
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
        fileSizeBytes: 256 * 1024,
      });

      const segments = res.s3Key.split('/');
      expect(segments[0]).toBe(orgId);
    });

    it('should sanitize fileName and strip path traversal characters', () => {
      const traversal = '../../../../etc/passwd';
      const sanitized = sanitizeFileName(traversal);
      expect(sanitized).not.toContain('..');
      expect(sanitized).not.toContain('/');

      const windowsTraversal = '..\\..\\boot.ini';
      const sanitizedWin = sanitizeFileName(windowsTraversal);
      expect(sanitizedWin).not.toContain('..');
      expect(sanitizedWin).not.toContain('\\');
    });
  });

  describe('S3Service Object Confirmation Checks', () => {
    it('should return exists: false for non-existent S3 keys', async () => {
      const res = await S3Service.confirmUpload('non-existent-key');
      expect(res.exists).toBe(false);
      expect(res.actualMimeType).toBe('');
      expect(res.fileSizeBytes).toBe(0);
    });

    it('should return metadata parameters for valid S3 keys', async () => {
      const res = await S3Service.confirmUpload('valid-key');
      expect(res.exists).toBe(true);
      expect(res.actualMimeType).toBe('image/png');
      expect(res.fileSizeBytes).toBe(2048);
    });
  });

  describe('Upload Router Endpoints Integration Tests', () => {
    it('POST /api/v1/uploads/presign should generate presigned PUT url and save audit trail', async () => {
      const res = await request(app)
        .post('/api/v1/uploads/presign')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          fileName: 'avatar.webp',
          mimeType: 'image/webp',
          fileSizeBytes: 500000,
          jobId,
        });

      expect(res.status).toBe(200);
      expect(res.body.uploadUrl).toBe('https://s3.amazonaws.com/mock-signed-url');
      expect(res.body.s3Key).toContain(`${orgId}/jobs/${jobId}/`);
      
      // Confirm audit log was saved
      expect(mockAuditLogs.length).toBeGreaterThanOrEqual(1);
      const log = mockAuditLogs[0];
      expect(log[0]).toBe(orgId);
      expect(log[1]).toBe(userId);
      expect(log[2]).toBe('ASSET_UPLOAD_INITIATED');
      expect(log[3]).toBe('detection_jobs');
      expect(log[4]).toBe(jobId);
    });

    it('POST /api/v1/uploads/confirm should confirm existing S3 asset and update detection_jobs columns', async () => {
      const validS3Key = `${orgId}/jobs/${jobId}/123456789-avatar.webp`;
      
      const res = await request(app)
        .post('/api/v1/uploads/confirm')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          s3Key: validS3Key,
          jobId,
        });

      expect(res.status).toBe(200);
      expect(res.body.confirmed).toBe(true);
      expect(res.body.mimeType).toBe('image/png'); // matches mock send payload
      expect(res.body.fileSizeBytes).toBe(2048);

      // Verify db job record is updated
      const updatedJob = mockJobs.find((j) => j.id === jobId);
      expect(updatedJob?.s3_key).toBe(validS3Key);
      expect(updatedJob?.source_metadata.mimeType).toBe('image/png');
      expect(updatedJob?.source_metadata.fileSizeBytes).toBe(2048);

      // Confirm second audit log was saved
      expect(mockAuditLogs.length).toBeGreaterThanOrEqual(1);
      const confirmLog = mockAuditLogs[mockAuditLogs.length - 1];
      expect(confirmLog[2]).toBe('ASSET_UPLOAD_COMPLETED');
    });

    it('POST /api/v1/uploads/confirm should fail with 403 if s3Key belongs to another organization', async () => {
      const foreignS3Key = `another-org-uuid/jobs/${jobId}/avatar.webp`;

      const res = await request(app)
        .post('/api/v1/uploads/confirm')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          s3Key: foreignS3Key,
          jobId,
        });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });
  });
});
