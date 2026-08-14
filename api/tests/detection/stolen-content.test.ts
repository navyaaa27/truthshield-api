import { jest } from '@jest/globals';

// --- Global Mocks Setup ---

jest.mock('fs/promises', () => {
  return {
    writeFile: jest.fn().mockImplementation(() => Promise.resolve()),
    unlink: jest.fn().mockImplementation(() => Promise.resolve()),
    rmdir: jest.fn().mockImplementation(() => Promise.resolve()),
    rm: jest.fn().mockImplementation(() => Promise.resolve()),
    mkdir: jest.fn().mockImplementation(() => Promise.resolve()),
  };
});

jest.mock('../../src/utils/tempFiles.js', () => {
  return {
    createTempDir: jest.fn().mockImplementation(() => Promise.resolve('/tmp/mock-stolen-analysis')),
    cleanupTempDir: jest.fn().mockImplementation(() => Promise.resolve()),
  };
});

jest.mock('../../src/shared/redis/index.js', () => {
  return {
    redis: {
      get: jest.fn().mockImplementation(() => Promise.resolve(null)),
      set: jest.fn().mockImplementation(() => Promise.resolve('OK')),
      zadd: jest.fn().mockImplementation(() => Promise.resolve(1)),
      expire: jest.fn().mockImplementation(() => Promise.resolve(1)),
    },
  };
});

let mockDbRows: any[] = [];
jest.mock('../../src/shared/database/pool.js', () => {
  return {
    query: jest.fn().mockImplementation((text: unknown) => {
      const sql = (typeof text === 'string' ? text : '').trim().toLowerCase();
      if (sql.includes('select name from organizations')) {
        return Promise.resolve({ rows: [{ name: 'Acme Brand' }], rowCount: 1 });
      }
      if (sql.includes('select id, name, phash, org_id from brand_assets')) {
        return Promise.resolve({ rows: mockDbRows, rowCount: mockDbRows.length });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
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

// Mock sharp to return predictable binary hashes independent of host platform C++ binaries
let mockRawBuffer = Buffer.alloc(64, 128); // All gray by default (will evaluate to same values)
jest.mock('sharp', () => {
  return jest.fn().mockImplementation(() => {
    return {
      resize: jest.fn().mockReturnThis(),
      grayscale: jest.fn().mockReturnThis(),
      raw: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockImplementation(() => Promise.resolve(mockRawBuffer)),
    };
  });
});

// Mock axios
jest.mock('axios', () => {
  return {
    get: jest
      .fn()
      .mockImplementation(() => Promise.resolve({ data: '<html><body></body></html>' })),
    post: jest.fn().mockImplementation(() =>
      Promise.resolve({
        data: {
          content: [
            {
              text: JSON.stringify({
                subject: 'DMCA Takedown Notice',
                body: 'Generated DMCA Draft Text Notice',
                recipientType: 'platform',
              }),
            },
          ],
        },
      }),
    ),
  };
});

// --- Imports to Test ---
import { PHashService } from '../../src/modules/detection/stolen-content/phash.service.js';
import { ContentSearcher } from '../../src/modules/detection/stolen-content/content.searcher.js';
import { DMCAGenerator } from '../../src/modules/detection/stolen-content/dmca.generator.js';
import { StolenContentAnalyzer } from '../../src/modules/detection/stolen-content/stolen.analyzer.js';
import axios from 'axios';

describe('Stolen Content & DMCA Monitoring Module Tests', () => {
  const pHashService = new PHashService();
  const searcher = new ContentSearcher();
  const dmcaGenerator = new DMCAGenerator();
  const analyzer = new StolenContentAnalyzer();

  beforeEach(() => {
    mockDbRows = [];
    mockRawBuffer = Buffer.alloc(64, 128);
    jest.clearAllMocks();
  });

  describe('PHashService Fingerprinting Checks', () => {
    it('calculateSimilarity returns 100 for identical hashes', () => {
      const hash = '1'.repeat(64);
      expect(pHashService.calculateSimilarity(hash, hash)).toBe(100);
    });

    it('calculateSimilarity returns 0 for completely different hashes', () => {
      const hash1 = '1'.repeat(64);
      const hash2 = '0'.repeat(64);
      expect(pHashService.calculateSimilarity(hash1, hash2)).toBe(0);
    });

    it('calculateSimilarity correctly uses Hamming distance', () => {
      // 16 mismatches out of 64 bits = (1 - 16/64) * 100 = 75%
      const hash1 = '1'.repeat(48) + '0'.repeat(16);
      const hash2 = '1'.repeat(64);
      expect(pHashService.calculateSimilarity(hash1, hash2)).toBe(75);
    });

    it('findSimilarInDatabase returns empty for no matches', async () => {
      mockDbRows = [];
      const matches = await pHashService.findSimilarInDatabase('org-123', '1'.repeat(64), 90);
      expect(matches).toEqual([]);
    });

    it('findSimilarInDatabase classifies matchType correctly', async () => {
      mockDbRows = [
        { id: 'asset-1', name: 'Exact Match', phash: '1'.repeat(64), org_id: 'org-123' },
        {
          id: 'asset-2',
          name: 'Near Duplicate',
          phash: '1'.repeat(60) + '0'.repeat(4),
          org_id: 'org-123',
        }, // 4 mismatches = 93.75% -> 94%
        {
          id: 'asset-3',
          name: 'Similar',
          phash: '1'.repeat(54) + '0'.repeat(10),
          org_id: 'org-123',
        }, // 10 mismatches = 84.375% -> 84%
        {
          id: 'asset-4',
          name: 'Derivative',
          phash: '1'.repeat(42) + '0'.repeat(22),
          org_id: 'org-123',
        }, // 22 mismatches = 65.625% -> 66%
      ];

      const matches = await pHashService.findSimilarInDatabase('org-123', '1'.repeat(64), 60);

      expect(matches.length).toBe(4);
      expect(matches[0].matchType).toBe('exact');
      expect(matches[1].matchType).toBe('near_duplicate');
      expect(matches[2].matchType).toBe('similar');
      expect(matches[3].matchType).toBe('derivative');
    });
  });

  describe('ContentSearcher Crawler Operations', () => {
    it('Content searcher handles web search failure gracefully', async () => {
      // Mock axios to reject
      (axios.get as any).mockImplementationOnce(() => Promise.reject(new Error('Network Timeout')));

      const webResults = await (searcher as any).searchWebImages('test.jpg', 'org-123');
      expect(webResults).toEqual([]);
    });
  });

  describe('DMCAGenerator Drafting Safeguards', () => {
    it('DMCAGenerator only generates for similarity > 85', async () => {
      const draft = await dmcaGenerator.generateDMCADraft({
        infringingUrl: 'https://infringing.com/asset.jpg',
        originalAssetDescription: 'Proprietary digital media asset',
        orgName: 'Acme Corp',
        orgContact: 'legal@acme.com',
        matchSimilarity: 80, // Less than 85
      });

      expect(draft).toBeNull();
    });

    it('DMCAGenerator always includes disclaimer text', async () => {
      const draft = await dmcaGenerator.generateDMCADraft({
        infringingUrl: 'https://infringing.com/asset.jpg',
        originalAssetDescription: 'Proprietary digital media asset',
        orgName: 'Acme Corp',
        orgContact: 'legal@acme.com',
        matchSimilarity: 95, // Greater than 85
      });

      expect(draft).not.toBeNull();
      expect(draft?.body).toContain('DISCLAIMER: This is an AI-generated draft.');
    });
  });

  describe('StolenContentAnalyzer Workspaces', () => {
    it('StolenContentAnalyzer cleans up temp files even on error', async () => {
      const { cleanupTempDir } = require('../../src/utils/tempFiles.js') as any;
      cleanupTempDir.mockClear();

      // Force fetch download to reject to simulate analysis crash
      (global.fetch as any).mockImplementationOnce(() =>
        Promise.reject(new Error('S3 Connection Lost')),
      );

      const mockJob = {
        id: 'job-123',
        s3_key: 'org-123/jobs/job-123/asset.png',
        org_id: 'org-123',
        content_type: 'image',
      };

      await expect(analyzer.analyze(mockJob)).rejects.toThrow('S3 Connection Lost');
      expect(cleanupTempDir).toHaveBeenCalled();
    });
  });

  describe('Dual-Fixture Visual Check Simulation', () => {
    it('accurately distinguishes between identical pairs and completely different pairs', async () => {
      // 1. Setup mock assets in Brand catalog
      // We will pretend the catalog has a registered asset with all '1's
      mockDbRows = [
        {
          id: 'asset-registered',
          name: 'Original Master Copy',
          phash: '1'.repeat(64),
          org_id: 'org-123',
        },
      ];

      const mockJob = {
        id: 'job-identical',
        s3_key: 'org-123/jobs/job-identical/matching.png',
        org_id: 'org-123',
        content_type: 'image',
      };

      // Scenario A: Input image evaluates to the identical hash (all 1s)
      // We modify our sharp raw pixel buffer so the average comparison results in all 1s
      mockRawBuffer = Buffer.alloc(64, 200); // 200 is always >= average of all 200s (evaluated as true -> 1)

      const identicalResult = await analyzer.analyze(mockJob);
      expect(identicalResult.score).toBe(95); // Exact Match found -> Score = 95
      expect(identicalResult.verdict).toBe('stolen');
      expect(identicalResult.confidence).toBe(95); // Exact Match overrides to 95
      expect(identicalResult.flags).toContain('exact_duplicate_found');

      // Scenario B: Input image evaluates to a completely different hash (all 0s)
      // We alter the raw pixel buffer mock so it calculates all 0s
      // Since sharp raw grayscale buffer mock is mocked, we can simulate different hashes easily
      const spyCompute = jest.spyOn(PHashService.prototype, 'computeHash').mockResolvedValueOnce({
        hash: '0'.repeat(64), // Completely different hash
        hashType: 'phash',
        computedAt: new Date().toISOString(),
      });

      const differentResult = await analyzer.analyze(mockJob);
      expect(differentResult.score).toBe(5); // No matches found -> Score = 5
      expect(differentResult.verdict).toBe('clean');
      expect(differentResult.confidence).toBe(50); // No matches overrides to 50
      expect(differentResult.flags).not.toContain('exact_duplicate_found');

      spyCompute.mockRestore();
    });
  });
});
