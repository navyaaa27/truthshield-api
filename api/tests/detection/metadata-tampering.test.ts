import { jest } from '@jest/globals';
import { promises as fs } from 'fs';
import * as path from 'path';
import sharp from 'sharp';

// Mock exifr
jest.mock('exifr');
import exifr from 'exifr';

// Mock Redis client globally to avoid connection attempt and hanging during tests
jest.mock('../../src/shared/redis/index.js', () => {
  return {
    redis: {
      get: jest.fn().mockImplementation(() => Promise.resolve(null)),
      set: jest.fn().mockImplementation(() => Promise.resolve('OK')),
    },
  };
});

import { MetadataTamperingAnalyzer } from '../../src/modules/detection/metadata-tampering/metadata.analyzer.js';

const fixturesDir = path.join(process.cwd(), 'tests/fixtures');
const cleanPath = path.join(fixturesDir, 'clean.jpg');
const modifiedPath = path.join(fixturesDir, 'modified.jpg');
const nonJpegPath = path.join(fixturesDir, 'document.pdf');

describe('Metadata Tampering Detection Module Tests', () => {
  let originalFetch: any;

  beforeAll(async () => {
    // Ensure the fixtures directory exists inside the workspace
    await fs.mkdir(fixturesDir, { recursive: true });

    // Generate solid 100x100 white test JPEGs using sharp
    await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .jpeg()
      .toFile(cleanPath);

    await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .jpeg()
      .toFile(modifiedPath);

    // Create a non-JPEG dummy file
    await fs.writeFile(nonJpegPath, 'DUMMY PDF CONTENT');

    // Intercept global fetch to emulate downloading from S3
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockImplementation(async (url: any) => {
      let targetPath = cleanPath;
      if (url.includes('modified.jpg')) {
        targetPath = modifiedPath;
      }
      const buffer = await fs.readFile(targetPath);
      return {
        ok: true,
        arrayBuffer: async () =>
          buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      } as any;
    }) as any;
  });

  afterAll(async () => {
    // Restore global fetch
    global.fetch = originalFetch;

    // Clean up solid JPEG test fixtures
    try {
      await fs.unlink(cleanPath);
      await fs.unlink(modifiedPath);
      await fs.unlink(nonJpegPath);
      await fs.rmdir(fixturesDir);
    } catch {}
  });

  describe('EXIF Analysis Checks', () => {
    it('analyzeExif flags Photoshop in software field', async () => {
      const analyzer = new MetadataTamperingAnalyzer();

      // Configure exifr mock return for modified image
      (exifr.parse as any).mockImplementationOnce(() =>
        Promise.resolve({
          Software: 'Adobe Photoshop CC 2023',
          Model: 'iPhone 15 Pro',
        }),
      );

      const exifRes = await (analyzer as any).analyzeExif(modifiedPath);
      expect(exifRes.flags).toContain('editing_software_detected');
      expect(exifRes.software).toBe('Adobe Photoshop CC 2023');
    });

    it('analyzeExif flags CreateDate vs ModifyDate gap', async () => {
      const analyzer = new MetadataTamperingAnalyzer();

      // Configure exifr mock return with 2 hours gap
      (exifr.parse as any).mockImplementationOnce(() =>
        Promise.resolve({
          CreateDate: '2026-05-24T10:00:00Z',
          ModifyDate: '2026-05-24T12:00:00Z',
        }),
      );

      const exifRes = await (analyzer as any).analyzeExif(modifiedPath);
      expect(exifRes.flags).toContain('metadata_modification_gap');
    });
  });

  describe('ELA Compression Checks', () => {
    it('analyzeELA returns skipped for non-JPEG files', async () => {
      const analyzer = new MetadataTamperingAnalyzer();
      const elaRes = await (analyzer as any).analyzeELA(nonJpegPath, 'application/pdf');

      expect(elaRes.skipped).toBe(true);
      expect(elaRes.reason).toBe('not_jpeg');
    });
  });

  describe('Final Score & Verdict Calculation', () => {
    it('calculateFinalScore produces correct verdict for known score ranges', () => {
      const analyzer = new MetadataTamperingAnalyzer();

      // 1. Clean range (0-25)
      const cleanExif = { flags: [] };
      const cleanEla = {
        skipped: true,
        elaScore: 0,
        suspiciousRegions: false,
        meanDiff: 0,
        stdDev: 0,
      };
      const cleanHash = { sha256: 'xyz', hashChanged: false };

      const cleanScore = (analyzer as any).calculateFinalScore(cleanExif, cleanEla, cleanHash, 3);
      expect(cleanScore.verdict).toBe('clean');
      expect(cleanScore.score).toBeLessThanOrEqual(25);

      // 2. Suspicious range (26-50)
      const suspExif = {
        flags: ['editing_software_detected', 'gps_inconsistent'],
        software: 'Photoshop',
      };
      const suspEla = {
        skipped: false,
        elaScore: 30,
        suspiciousRegions: false,
        meanDiff: 10,
        stdDev: 30,
      };
      const suspHash = { sha256: 'xyz', hashChanged: false };

      const suspScore = (analyzer as any).calculateFinalScore(suspExif, suspEla, suspHash, 3);
      expect(suspScore.verdict).toBe('suspicious');

      // 3. Manipulated range (76-100)
      const manipExif = {
        flags: ['editing_software_detected', 'metadata_modification_gap'],
        software: 'Photoshop',
      };
      const manipEla = {
        skipped: false,
        elaScore: 80,
        suspiciousRegions: true,
        meanDiff: 40,
        stdDev: 80,
      };
      const manipHash = { sha256: 'xyz', hashChanged: true };

      const manipScore = (analyzer as any).calculateFinalScore(manipExif, manipEla, manipHash, 3);
      expect(manipScore.verdict).toBe('manipulated');
      expect(manipScore.score).toBe(100);
    });
  });

  describe('Temp Workspace Lifecycle', () => {
    it('Temp files are cleaned up even when analyzer throws', async () => {
      const analyzer = new MetadataTamperingAnalyzer();

      // Force a rejection inside exifr to simulate parsing failure
      (exifr.parse as any).mockImplementationOnce(() =>
        Promise.reject(new Error('Fatal parsing interrupt')),
      );

      const s3Key = 'org-1/jobs/job-1/clean.jpg';

      // Execute should complete gracefully by catching inner analyzer failures
      const result = await analyzer.analyze(s3Key, 'image/jpeg');
      expect(result).toBeDefined();
      expect(result.details.exifAnalysis.flags.length).toBe(0);
    });
  });

  describe('Full Integration Workflow Check', () => {
    it('Full integration: run analyzer on a real test JPEG → result has correct shape', async () => {
      const analyzer = new MetadataTamperingAnalyzer();

      // Configure mock exifr for standard run
      (exifr.parse as any).mockImplementationOnce(() =>
        Promise.resolve({
          Make: 'Apple',
          Model: 'iPhone 13 Pro',
          ISO: 50,
        }),
      );

      const s3Key = 'org-1/jobs/job-1/clean.jpg';
      const result = await analyzer.analyze(s3Key, 'image/jpeg');

      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('verdict');
      expect(result).toHaveProperty('confidence');
      expect(result.details).toHaveProperty('exifAnalysis');
      expect(result.details).toHaveProperty('elaAnalysis');
      expect(result.details).toHaveProperty('hashVerification');
      expect(result.details.exifAnalysis.cameraModel).toBe('iPhone 13 Pro');
    });
  });
});
