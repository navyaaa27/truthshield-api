import { jest } from '@jest/globals';

// --- Global Mocks Setup ---

jest.mock('fs/promises', () => {
  return {
    readFile: jest.fn().mockImplementation(() => Promise.resolve(Buffer.alloc(100))),
    writeFile: jest.fn().mockImplementation(() => Promise.resolve()),
    unlink: jest.fn().mockImplementation(() => Promise.resolve()),
    mkdir: jest.fn().mockImplementation(() => Promise.resolve()),
    rm: jest.fn().mockImplementation(() => Promise.resolve()),
  };
});

jest.mock('../../src/utils/tempFiles.js', () => {
  return {
    createTempDir: jest
      .fn()
      .mockImplementation(() => Promise.resolve('/tmp/mock-deepfake-analysis')),
    cleanupTempDir: jest.fn().mockImplementation(() => Promise.resolve()),
  };
});

jest.mock('../../src/shared/redis/index.js', () => {
  return {
    redis: {
      get: jest.fn().mockImplementation(() => Promise.resolve(null)),
      set: jest.fn().mockImplementation(() => Promise.resolve('OK')),
    },
  };
});

jest.mock('../../src/shared/database/pool.js', () => {
  return {
    query: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ rows: [{ id: 'result-1', score: 0 }], rowCount: 1 }),
      ),
  };
});

jest.mock('../../src/shared/storage/s3.service.js', () => {
  return {
    S3Service: {
      getPresignedDownloadUrl: jest
        .fn()
        .mockImplementation(() => Promise.resolve('https://s3.amazonaws.com/mock-download-url')),
    },
  };
});

// Mock global fetch
const mockFetchResponse = {
  ok: true,
  arrayBuffer: () => Promise.resolve(Buffer.alloc(100).buffer),
};
global.fetch = jest.fn().mockImplementation(() => Promise.resolve(mockFetchResponse)) as any;

// Mock sharp
jest.mock('sharp', () => {
  return jest.fn().mockImplementation(() => {
    return {
      resize: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockImplementation(() => Promise.resolve(Buffer.alloc(50))),
    };
  });
});

// Mock fluent-ffmpeg
jest.mock('fluent-ffmpeg', () => {
  const mockFfmpeg: any = jest.fn().mockImplementation(() => ({
    screenshot: jest.fn().mockReturnThis(),
    on: jest.fn().mockImplementation(function (this: any, ...args: unknown[]) {
      const event = args[0] as string;
      const cb = args[1] as () => void;
      if (event === 'end') {
        setTimeout(() => cb(), 10);
      }
      return this;
    }),
  }));
  mockFfmpeg.ffprobe = jest.fn().mockImplementation((...args: unknown[]) => {
    const cb = args[1] as (err: null, data: any) => void;
    cb(null, { format: { duration: 30 } });
  });
  return mockFfmpeg;
});

// Mock axios for Hive API
let mockAxiosPost: any;
jest.mock('axios', () => {
  mockAxiosPost = jest.fn().mockImplementation(() =>
    Promise.resolve({
      status: 200,
      data: {
        status: [
          {
            response: {
              output: [
                { class: 'deepfake', score: 0.85 },
                { class: 'face_swap', score: 0.3 },
                { class: 'gan_generated', score: 0.1 },
              ],
            },
          },
        ],
      },
    }),
  );
  return {
    post: mockAxiosPost,
    get: jest.fn().mockImplementation(() => Promise.resolve({ data: '' })),
  };
});

// --- Imports Under Test ---
import {
  HiveClient,
  AuthError,
  RateLimitError,
  ExternalServiceError,
} from '../../src/modules/detection/deepfake/hive.client.js';
import { RekognitionClient } from '../../src/modules/detection/deepfake/rekognition.client.js';
import { DeepfakeAnalyzer } from '../../src/modules/detection/deepfake/deepfake.analyzer.js';
import { FrameExtractor } from '../../src/modules/detection/deepfake/frame.extractor.js';
import { handleDeepfake } from '../../src/modules/detection/deepfake/deepfake.handler.js';
import { env } from '../../src/config/env.js';

describe('Deepfake Detection Module Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── HiveClient Tests ───────────────────────────────────────────────

  describe('HiveClient', () => {
    const hiveClient = new HiveClient();

    it('handles 429 rate limit response correctly', async () => {
      const axiosMock = require('axios') as any;
      axiosMock.post.mockImplementationOnce(() =>
        Promise.reject({
          response: {
            status: 429,
            headers: { 'retry-after': '120' },
          },
        }),
      );

      await expect(hiveClient.analyzeImage('/fake/image.jpg')).rejects.toThrow(RateLimitError);

      try {
        await hiveClient.analyzeImage('/fake/image.jpg');
      } catch (err: any) {
        // Re-mock for second assertion
        axiosMock.post.mockImplementationOnce(() =>
          Promise.reject({
            response: { status: 429, headers: { 'retry-after': '30' } },
          }),
        );
      }
    });

    it('handles 5xx error with ExternalServiceError', async () => {
      const axiosMock = require('axios') as any;
      axiosMock.post.mockImplementationOnce(() =>
        Promise.reject({
          response: { status: 503 },
        }),
      );

      await expect(hiveClient.analyzeImage('/fake/image.jpg')).rejects.toThrow(
        ExternalServiceError,
      );
    });

    it('handles 401 with AuthError', async () => {
      const axiosMock = require('axios') as any;
      axiosMock.post.mockImplementationOnce(() =>
        Promise.reject({
          response: { status: 401 },
        }),
      );

      await expect(hiveClient.analyzeImage('/fake/image.jpg')).rejects.toThrow(AuthError);
    });

    it('parseHiveResponse extracts scores correctly', () => {
      const raw = {
        status: [
          {
            response: {
              output: [
                { class: 'deepfake', score: 0.92 },
                { class: 'face_swap', score: 0.75 },
                { class: 'gan_generated', score: 0.6 },
              ],
            },
          },
        ],
      };

      const result = hiveClient.parseHiveResponse(raw);
      expect(result.deepfakeScore).toBe(0.92);
      expect(result.faceSwapScore).toBe(0.75);
      expect(result.ganGeneratedScore).toBe(0.6);
      expect(result.classes.length).toBe(3);
    });

    it('parseHiveResponse defaults to 0 for missing classes', () => {
      const raw = {
        status: [
          {
            response: {
              output: [{ class: 'deepfake', score: 0.5 }],
            },
          },
        ],
      };

      const result = hiveClient.parseHiveResponse(raw);
      expect(result.deepfakeScore).toBe(0.5);
      expect(result.faceSwapScore).toBe(0);
      expect(result.ganGeneratedScore).toBe(0);
    });
  });

  // ─── DeepfakeAnalyzer Scoring Tests ─────────────────────────────────

  describe('DeepfakeAnalyzer Scoring', () => {
    const analyzer = new DeepfakeAnalyzer();

    it('calculateImageScore returns 10 when no faces detected', () => {
      const hive = {
        deepfakeScore: 0.9,
        faceSwapScore: 0.8,
        ganGeneratedScore: 0.5,
        classes: [],
        rawResponse: {},
      };
      const rekognition = {
        faceCount: 0,
        faces: [],
        qualityScore: 0,
        rawResponse: {},
      };

      const score = analyzer.calculateImageScore(hive, rekognition);
      expect(score).toBe(10);
    });

    it('calculateImageScore correctly weights Hive signals', () => {
      const hive = {
        deepfakeScore: 0.6,
        faceSwapScore: 0.8, // > 0.7 → +20
        ganGeneratedScore: 0.3,
        classes: [],
        rawResponse: {},
      };
      const rekognition = {
        faceCount: 1,
        faces: [
          {
            boundingBox: { top: 0.1, left: 0.2, width: 0.3, height: 0.4 },
            confidence: 99,
            landmarks: null,
            faceIndex: 0,
          },
        ],
        qualityScore: 75,
        rawResponse: {},
      };

      const score = analyzer.calculateImageScore(hive, rekognition);
      // Base = 0.6 * 100 = 60, +20 for faceSwap > 0.7 = 80
      expect(score).toBe(80);
    });

    it('calculateFrameScore returns 0 when both APIs are null', () => {
      const score = analyzer.calculateFrameScore(null, null);
      expect(score).toBe(0);
    });
  });

  // ─── DeepfakeAnalyzer Fallback Tests ────────────────────────────────

  describe('DeepfakeAnalyzer Fallbacks', () => {
    it('falls back gracefully when Hive API fails (uses Rekognition only)', async () => {
      const analyzer = new DeepfakeAnalyzer();

      // Override hive to fail
      const hiveSpyOn = jest
        .spyOn(HiveClient.prototype, 'analyzeImage')
        .mockRejectedValue(new Error('Hive API down'));

      const mockJob = {
        id: 'job-df-1',
        s3_key: 'org-1/jobs/job-df-1/face.jpg',
        org_id: 'org-1',
        content_type: 'image',
      };

      const result = await analyzer.analyze(mockJob);

      // Should still produce a result using Rekognition alone
      expect(result.verdict).toBeDefined();
      expect(result.confidence).toBeLessThanOrEqual(70); // No Hive = max 55 confidence
      expect(result.details.contentType).toBe('image');

      hiveSpyOn.mockRestore();
    });

    it('falls back gracefully when both APIs fail (returns low-confidence result)', async () => {
      const analyzer = new DeepfakeAnalyzer();

      const hiveSpyOn = jest
        .spyOn(HiveClient.prototype, 'analyzeImage')
        .mockRejectedValue(new Error('Hive down'));
      const rekognitionSpyOn = jest
        .spyOn(RekognitionClient.prototype, 'detectFaces')
        .mockRejectedValue(new Error('Rekognition down'));

      const mockJob = {
        id: 'job-df-2',
        s3_key: 'org-1/jobs/job-df-2/face.jpg',
        org_id: 'org-1',
        content_type: 'image',
      };

      const result = await analyzer.analyze(mockJob);

      expect(result.score).toBe(0);
      expect(result.verdict).toBe('clean');
      expect(result.confidence).toBe(20);
      expect(result.flags).toContain('analysis_incomplete');

      hiveSpyOn.mockRestore();
      rekognitionSpyOn.mockRestore();
    });
  });

  // ─── FrameExtractor Tests ──────────────────────────────────────────

  describe('FrameExtractor', () => {
    it('cleans up temp frames after analysis', async () => {
      const { cleanupTempDir } = require('../../src/utils/tempFiles.js') as any;
      cleanupTempDir.mockClear();

      const analyzer = new DeepfakeAnalyzer();
      const mockJob = {
        id: 'job-df-3',
        s3_key: 'org-1/jobs/job-df-3/face.jpg',
        org_id: 'org-1',
        content_type: 'image',
      };

      await analyzer.analyze(mockJob);
      expect(cleanupTempDir).toHaveBeenCalled();
    });

    it('getVideoDuration returns fallback if ffprobe errors', async () => {
      const extractor = new FrameExtractor();
      const ffmpeg = require('fluent-ffmpeg') as any;
      ffmpeg.ffprobe.mockImplementationOnce((_path: unknown, cb: any) => {
        cb(new Error('ffprobe not found'));
      });

      const duration = await extractor.getVideoDuration('/fake/video.mp4');
      expect(duration).toBe(10); // Fallback default
    });
  });

  // ─── handleDeepfake Handler Tests ──────────────────────────────────

  describe('handleDeepfake Handler', () => {
    it('returns graceful result when API key not configured', async () => {
      // Temporarily clear the Hive API key
      const originalKey = env.HIVE_MODERATION_API_KEY;
      (env as any).HIVE_MODERATION_API_KEY = '';

      const mockJob = {
        id: 'job-df-4',
        s3_key: 'org-1/jobs/job-df-4/face.jpg',
        org_id: 'org-1',
        content_type: 'image',
      };

      const result = await handleDeepfake(mockJob);

      expect(result).toBeDefined();
      // Verify DB was called to persist the unavailable result
      const { query: dbQuery } = require('../../src/shared/database/pool.js') as any;
      expect(dbQuery).toHaveBeenCalled();

      // The persisted result should contain our unavailable flags
      const lastCall = dbQuery.mock.calls[dbQuery.mock.calls.length - 1];
      const flagsArg = lastCall[1][4]; // 5th param = flags
      expect(flagsArg).toContain('deepfake_detection_unavailable');

      // Restore
      (env as any).HIVE_MODERATION_API_KEY = originalKey;
    });

    it('rejects invalid content type', async () => {
      const mockJob = {
        id: 'job-df-5',
        s3_key: 'org-1/jobs/job-df-5/doc.pdf',
        org_id: 'org-1',
        content_type: 'document',
      };

      await expect(handleDeepfake(mockJob)).rejects.toThrow(/only supports image or video/);
    });
  });

  // ─── RekognitionClient Tests ───────────────────────────────────────

  describe('RekognitionClient', () => {
    it('hasSuspiciousFaceAttributes detects low confidence', () => {
      const client = new RekognitionClient();
      const result = {
        faceCount: 1,
        faces: [
          {
            boundingBox: { top: 0, left: 0, width: 0.5, height: 0.5 },
            confidence: 60, // < 80
            landmarks: null,
            faceIndex: 0,
          },
        ],
        qualityScore: 40, // < 50
        rawResponse: {},
      };

      const flags = client.hasSuspiciousFaceAttributes(result);
      expect(flags).toContain('low_face_confidence');
      expect(flags).toContain('low_sharpness');
    });

    it('hasSuspiciousFaceAttributes detects face quality mismatch', () => {
      const client = new RekognitionClient();
      const result = {
        faceCount: 2,
        faces: [
          {
            boundingBox: { top: 0, left: 0, width: 0.3, height: 0.3 },
            confidence: 99,
            landmarks: null,
            faceIndex: 0,
          },
          {
            boundingBox: { top: 0.5, left: 0.5, width: 0.3, height: 0.3 },
            confidence: 40, // Big gap from 99 → triggers lighting_inconsistency AND face_quality_mismatch
            landmarks: null,
            faceIndex: 1,
          },
        ],
        qualityScore: 75,
        rawResponse: {},
      };

      const flags = client.hasSuspiciousFaceAttributes(result);
      expect(flags).toContain('lighting_inconsistency');
      expect(flags).toContain('face_quality_mismatch');
    });

    it('returns empty flags for no faces', () => {
      const client = new RekognitionClient();
      const result = {
        faceCount: 0,
        faces: [],
        qualityScore: 0,
        rawResponse: {},
      };

      const flags = client.hasSuspiciousFaceAttributes(result);
      expect(flags).toEqual([]);
    });
  });
});
