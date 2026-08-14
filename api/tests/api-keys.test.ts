/* eslint-disable @typescript-eslint/ban-ts-comment */
process.env.ENABLE_SECURITY_MIDDLEWARE = 'false';
import { jest } from '@jest/globals';
import crypto from 'crypto';

// Setup Mock DB Store
let mockApiKeys: any[] = [];
let mockAuditLogs: any[] = [];
let mockJobs: any[] = [];
let mockBrandAssets: any[] = [];

// Mock Redis Client
let mockRedisStore: Record<string, string> = {};
const mockSubClient = {
  on: jest.fn(),
  quit: jest.fn().mockImplementation(() => Promise.resolve()),
};

jest.mock('../src/shared/redis/redis.client.js', () => ({
  redisClient: {
    duplicate: jest.fn().mockReturnValue(mockSubClient),
    get: jest.fn().mockImplementation(((key: any) => {
      const k = key.startsWith('ts:') ? key.substring(3) : key;
      return Promise.resolve(mockRedisStore[k] || null);
    }) as any),
    setex: jest.fn().mockImplementation(((key: any, _ttl: any, val: any) => {
      const k = key.startsWith('ts:') ? key.substring(3) : key;
      mockRedisStore[k] = val;
      return Promise.resolve('OK');
    }) as any),
    del: jest.fn().mockImplementation(((...keys: any[]) => {
      for (const key of keys) {
        const k = key.startsWith('ts:') ? key.substring(3) : key;
        delete mockRedisStore[k];
      }
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
    ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
  },
  isRedisHealthy: jest.fn().mockImplementation(() => Promise.resolve(true)),
  getRedisLatency: jest.fn().mockImplementation(() => Promise.resolve(5)),
}));

// Mock Database Queries
jest.mock('../src/shared/database/pool.js', () => ({
  pool: {
    connect: jest.fn().mockImplementation(() =>
      Promise.resolve({
        query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
        release: jest.fn(),
      }),
    ),
    end: jest.fn().mockImplementation(() => Promise.resolve()),
  },
  query: jest.fn().mockImplementation(((text: string, params?: any[]) => {
    const sql = (text || '').trim().toLowerCase();
    const p = params || [];

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
        allowed_ips: p[6],
        rate_limit_override: p[7],
        expires_at: p[8],
        is_active: true,
        total_requests: 0,
        created_at: new Date().toISOString(),
      };
      mockApiKeys.push(newKey);
      return Promise.resolve({ rows: [newKey], rowCount: 1 });
    }

    // SELECT k.*, o.name as org_name
    if (sql.includes('select k.*, o.name as org_name')) {
      const hash = p[0];
      const match = mockApiKeys.find((k) => k.key_hash === hash);
      if (match) {
        return Promise.resolve({
          rows: [
            {
              ...match,
              org_name: 'Test Org',
              org_plan_tier: 'enterprise',
            },
          ],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // SELECT key_hash, org_id FROM api_keys WHERE id = $1
    if (sql.includes('select key_hash, org_id from api_keys')) {
      const keyId = p[0];
      const match = mockApiKeys.find((k) => k.id === keyId);
      if (match) {
        return Promise.resolve({ rows: [match], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // SELECT name, scopes, allowed_ips, rate_limit_override, expires_at FROM api_keys
    if (sql.includes('select name, scopes, allowed_ips, rate_limit_override, expires_at')) {
      const keyId = p[0];
      const orgId = p[1];
      const match = mockApiKeys.find((k) => k.id === keyId && k.org_id === orgId);
      if (match) {
        return Promise.resolve({ rows: [match], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // UPDATE api_keys SET is_active = false
    if (sql.includes('update api_keys') && sql.includes('is_active = false')) {
      const revokedBy = p[0];
      const keyId = p[1];
      const match = mockApiKeys.find((k) => k.id === keyId);
      if (match) {
        match.is_active = false;
        match.revoked_at = new Date().toISOString();
        match.revoked_by = revokedBy;
      }
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // UPDATE api_keys SET last_used_at = NOW()
    if (sql.includes('update api_keys') && sql.includes('last_used_at')) {
      const ip = p[0];
      const keyId = p[1];
      const match = mockApiKeys.find((k) => k.id === keyId);
      if (match) {
        match.last_used_at = new Date().toISOString();
        match.last_used_ip = ip;
        match.total_requests += 1;
      }
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // SELECT id, name, key_prefix, scopes... FROM api_keys
    if (sql.includes('select id, name, key_prefix')) {
      const orgId = p[0];
      const matches = mockApiKeys
        .filter((k) => k.org_id === orgId)
        .map((k) => {
          const { key_hash, ...rest } = k;
          return rest;
        });
      return Promise.resolve({ rows: matches, rowCount: matches.length });
    }

    // INSERT INTO audit_logs
    if (sql.includes('insert into audit_logs')) {
      mockAuditLogs.push({ orgId: p[0], userId: p[1], action: p[2] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // INSERT INTO detection_jobs
    if (sql.includes('insert into detection_jobs')) {
      const job = {
        id: crypto.randomUUID(),
        org_id: p[0],
        created_by: p[1],
        content_type: p[2],
        detection_modules: p[3],
        priority: p[4],
        source_url: p[5],
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      mockJobs.push(job);
      return Promise.resolve({ rows: [job], rowCount: 1 });
    }

    // UPDATE detection_jobs SET source_metadata = $1 WHERE id = $2
    if (sql.includes('update detection_jobs set source_metadata = $1')) {
      const metadata = p[0];
      const jobId = p[1];
      const match = mockJobs.find((j) => j.id === jobId);
      if (match) {
        match.source_metadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // UPDATE detection_jobs SET s3_key = $1 WHERE id = $2
    if (sql.includes('update detection_jobs set s3_key = $1')) {
      const s3Key = p[0];
      const jobId = p[1];
      const match = mockJobs.find((j) => j.id === jobId);
      if (match) {
        match.s3_key = s3Key;
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // SELECT * FROM detection_jobs WHERE id = $1 AND org_id = $2
    if (sql.includes('select * from detection_jobs')) {
      const jobId = p[0];
      const orgId = p[1];
      const match = mockJobs.find((j) => j.id === jobId && j.org_id === orgId);
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // INSERT INTO brand_assets
    if (sql.includes('insert into brand_assets')) {
      const asset = {
        id: crypto.randomUUID(),
        org_id: p[0],
        uploaded_by: p[1],
        asset_name: p[2],
        asset_type: p[3],
        s3_key: p[4],
        file_size_bytes: p[5],
        mime_type: p[6],
        is_active: true,
        created_at: new Date().toISOString(),
      };
      mockBrandAssets.push(asset);
      return Promise.resolve({ rows: [asset], rowCount: 1 });
    }

    // SELECT id, org_id, uploaded_by, asset_name... FROM brand_assets
    if (sql.includes('select id, org_id, uploaded_by')) {
      const orgId = p[0];
      const matches = mockBrandAssets.filter((a) => a.org_id === orgId && a.is_active);
      return Promise.resolve({ rows: matches, rowCount: matches.length });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  }) as any),
}));

// Mock Database Index
jest.mock('../src/shared/database/index.js', () => ({
  checkDatabaseHealth: (jest.fn() as any).mockResolvedValue({
    status: 'healthy',
    writePool: { connected: true },
    readPool: { connected: true },
  }),
}));

// Mock S3Service
jest.mock('../src/shared/storage/s3.service.js', () => ({
  S3Service: {
    getPresignedUploadUrl: jest.fn().mockImplementation(((params: any) => {
      return Promise.resolve({
        uploadUrl: `https://mock-s3-presigned-url/${params.jobId}`,
        s3Key: `${params.orgId}/jobs/${params.jobId}/mock_file.png`,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });
    }) as any),
  },
}));

// Mock BullMQ Dispatcher
jest.mock('../src/modules/jobs/job.dispatcher.js', () => ({
  dispatchJob: jest.fn().mockImplementation(() => Promise.resolve()),
}));

// Mock Queue service
jest.mock('../src/shared/queue/queues.js', () => ({
  detectionQueue: {
    getJobCounts: (jest.fn() as any).mockResolvedValue({ waiting: 0 }),
    add: (jest.fn() as any).mockResolvedValue({}),
  },
  alertQueue: {
    getJobCounts: (jest.fn() as any).mockResolvedValue({ waiting: 0 }),
    add: (jest.fn() as any).mockResolvedValue({}),
  },
  cleanupQueue: {
    getJobCounts: (jest.fn() as any).mockResolvedValue({ waiting: 0 }),
  },
  reportQueue: {
    getJobCounts: (jest.fn() as any).mockResolvedValue({ waiting: 0 }),
  },
}));

import { app } from '../src/app.js';
import { ApiKeyService } from '../src/modules/api-keys/apikey.service.js';

describe('API Key Management & Client Authentication Suite', () => {
  beforeEach(() => {
    mockApiKeys = [];
    mockAuditLogs = [];
    mockJobs = [];
    mockBrandAssets = [];
    mockRedisStore = {};
  });

  it('should successfully create an API key, returning the plain text key only once', async () => {
    const { apiKey, plainKey } = await ApiKeyService.createApiKey({
      orgId: 'org-uuid-1',
      createdBy: 'user-uuid-1',
      name: 'Development Integration Key',
      scopes: ['jobs:create', 'jobs:read'],
    });

    expect(apiKey).toBeDefined();
    expect(apiKey.name).toBe('Development Integration Key');
    expect(apiKey.key_prefix).toBeDefined();
    expect(plainKey).toBeDefined();
    expect(plainKey.startsWith('ts_live_')).toBe(true);

    // Confirm stored key is hashed, and plain key is never in the DB/record
    expect(apiKey.key_hash).not.toBe(plainKey);
    const hash = crypto.createHash('sha256').update(plainKey).digest('hex');
    expect(apiKey.key_hash).toBe(hash);

    // Check list method does NOT contain the key_hash
    const keysList = await ApiKeyService.listApiKeys('org-uuid-1');
    expect(keysList.length).toBe(1);
    expect((keysList[0] as any).key_hash).toBeUndefined();
  });

  it('should reject creation with invalid scopes or malformed allowed IPs', async () => {
    await expect(
      ApiKeyService.createApiKey({
        orgId: 'org-uuid-1',
        createdBy: 'user-uuid-1',
        name: 'Invalid Scopes Key',
        scopes: ['jobs:create', 'malicious:scope'],
      }),
    ).rejects.toThrow('Invalid API key scope: malicious:scope');

    await expect(
      ApiKeyService.createApiKey({
        orgId: 'org-uuid-1',
        createdBy: 'user-uuid-1',
        name: 'Invalid IPs Key',
        scopes: ['jobs:create'],
        allowedIps: ['999.999.999.999'],
      }),
    ).rejects.toThrow('Invalid allowed IP or CIDR range: 999.999.999.999');
  });

  it('should validate active keys and reject expired, revoked, or non-matching IP keys', async () => {
    // 1. Create Key
    const { apiKey, plainKey } = await ApiKeyService.createApiKey({
      orgId: 'org-uuid-1',
      createdBy: 'user-uuid-1',
      name: 'Core Validation Key',
      scopes: ['jobs:create'],
      allowedIps: ['192.168.1.0/24'],
    });

    // Valid check within correct IP range
    const resValid = await ApiKeyService.validateApiKey(plainKey, '192.168.1.50');
    expect(resValid.valid).toBe(true);
    expect(resValid.apiKey?.id).toBe(apiKey.id);

    // Invalid check from outside IP range
    const resBadIp = await ApiKeyService.validateApiKey(plainKey, '10.0.0.1');
    expect(resBadIp.valid).toBe(false);
    expect(resBadIp.reason).toContain('not authorized');

    // 2. Expired Check
    const expiredRes = await ApiKeyService.createApiKey({
      orgId: 'org-uuid-1',
      createdBy: 'user-uuid-1',
      name: 'Expired Key',
      scopes: ['jobs:create'],
      expiresAt: new Date(Date.now() - 10000), // expired 10s ago
    });

    const resExpired = await ApiKeyService.validateApiKey(expiredRes.plainKey, '192.168.1.50');
    expect(resExpired.valid).toBe(false);
    expect(resExpired.reason).toContain('expired');

    // 3. Revocation Check
    await ApiKeyService.revokeApiKey(apiKey.id, 'org-uuid-1', 'user-uuid-1');
    const resRevoked = await ApiKeyService.validateApiKey(plainKey, '192.168.1.50');
    expect(resRevoked.valid).toBe(false);
    expect(resRevoked.reason).toContain('revoked');
  });

  it('should rotate keys properly by revoking the old key and issuing a new one with matching configuration', async () => {
    const { apiKey, plainKey } = await ApiKeyService.createApiKey({
      orgId: 'org-uuid-1',
      createdBy: 'user-uuid-1',
      name: 'Key To Rotate',
      scopes: ['jobs:create', 'results:read'],
      allowedIps: ['192.168.5.5'],
    });

    const rotation = await ApiKeyService.rotateApiKey(apiKey.id, 'org-uuid-1', 'user-uuid-1');
    expect(rotation.apiKey.name).toBe('Key To Rotate');
    expect(rotation.apiKey.scopes).toEqual(['jobs:create', 'results:read']);
    expect(rotation.apiKey.allowed_ips).toEqual(['192.168.5.5']);
    expect(rotation.plainKey).toBeDefined();

    // Verify old key is revoked
    const resOld = await ApiKeyService.validateApiKey(plainKey);
    expect(resOld.valid).toBe(false);

    // Verify new rotated key is valid
    const resNew = await ApiKeyService.validateApiKey(rotation.plainKey, '192.168.5.5');
    expect(resNew.valid).toBe(true);
  });

  it('should enforce authenticateApiKey endpoint permissions and scope restrictions', async () => {
    const supertest = (await import('supertest')).default;

    // 1. Create API key
    const { plainKey } = await ApiKeyService.createApiKey({
      orgId: 'org-uuid-1',
      createdBy: 'user-uuid-1',
      name: 'Client API Scope Test',
      scopes: ['jobs:create'], // missing assets:write scope!
    });

    // POST /api/v1/assets requires 'assets:write' scope
    const res403 = await supertest(app)
      .post('/api/v1/assets')
      .set('Authorization', `Bearer ${plainKey}`)
      .send({
        assetName: 'Test Logo',
        assetType: 'logo',
        s3Key: 'org-uuid-1/logo.png',
      });

    console.log('res403 status:', res403.status, 'body:', res403.body);
    expect(res403.status).toBe(403);
    expect(res403.body.message).toContain('Insufficient scopes');

    // POST /api/v1/analyze requires 'jobs:create' which we HAVE
    const res201 = await supertest(app)
      .post('/api/v1/analyze')
      .set('Authorization', `Bearer ${plainKey}`)
      .send({
        contentType: 'url',
        sourceUrl: 'https://news.com/article1',
        detectionModules: ['fake_news'],
      });

    expect(res201.status).toBe(201);
    expect(res201.body.jobId).toBeDefined();
  });
});
