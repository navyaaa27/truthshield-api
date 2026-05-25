import { jest } from '@jest/globals';
import { generateApiKey, hashApiKey } from '../src/utils/apiKey.js';

// Local database memory simulation for testing organizations
let mockOrgs: any[] = [];

// Mock the database queries
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

      // 1. Insert query
      if (sql.startsWith('insert into organizations')) {
        const name = p[0];
        const planTier = p[1] || 'starter';
        const newOrg = {
          id: `org-uuid-${Math.random().toString(36).substr(2, 9)}`,
          name,
          plan_tier: planTier,
          api_key_hash: null,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        };
        mockOrgs.push(newOrg);
        return Promise.resolve({ rows: [newOrg], rowCount: 1 });
      }

      // 2. Select query
      if (sql.startsWith('select') && sql.includes('where id = $1')) {
        const id = p[0];
        const org = mockOrgs.find((o) => o.id === id) || null;
        return Promise.resolve({ rows: org ? [org] : [], rowCount: org ? 1 : 0 });
      }

      // 3. Update active state (deactivate)
      if (sql.includes('set is_active = false')) {
        const id = p[0];
        const org = mockOrgs.find((o) => o.id === id);
        if (org) {
          org.is_active = false;
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      // 4. General updates
      if (sql.startsWith('update organizations')) {
        const id = p[p.length - 1];
        const org = mockOrgs.find((o) => o.id === id);
        if (org) {
          return Promise.resolve({ rows: [org], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      return Promise.resolve({ rows: [], rowCount: 0 });
    }) as any),
  };
});

import {
  createOrganization,
  getOrganizationById,
  updateOrganization,
  deactivateOrganization,
} from '../src/modules/organizations/organization.model.js';

describe('Organizations Module & API Key Security Tests', () => {
  beforeEach(() => {
    // Reset database memory between tests
    mockOrgs = [];
  });

  describe('API Key Cryptographic Utilities', () => {
    it('should generate unique API keys with the correct prefix and length', () => {
      const key = generateApiKey();
      expect(key.startsWith('ts_live_')).toBe(true);
      expect(key.length).toBe(48);

      // Verify cryptographic uniqueness (generate 100 keys, expect 0 collisions)
      const keys = new Set<string>();
      for (let i = 0; i < 100; i++) {
        keys.add(generateApiKey());
      }
      expect(keys.size).toBe(100);
    });

    it('should generate consistent SHA-256 hashes of exact length 64', () => {
      const key = 'ts_live_abc123';
      const hash1 = hashApiKey(key);
      const hash2 = hashApiKey(key);

      // Consistency checks
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // SHA-256 standard hex length
      expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);

      // Verify that changing one char yields completely distinct hashes (avalanche effect)
      const diffHash = hashApiKey('ts_live_abc124');
      expect(hash1).not.toBe(diffHash);
    });
  });

  describe('Database Model Actions', () => {
    it('should successfully create an organization with plan tiers and default active states', async () => {
      const org = await createOrganization('Cyberdyne Systems', 'enterprise');

      expect(org.id).toBeDefined();
      expect(org.name).toBe('Cyberdyne Systems');
      expect(org.plan_tier).toBe('enterprise');
      expect(org.is_active).toBe(true);
      expect(org.api_key_hash).toBeNull();
    });

    it('should retrieve a previously created organization by its UUID', async () => {
      const created = await createOrganization('Weyland-Yutani', 'starter');
      const retrieved = await getOrganizationById(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.name).toBe('Weyland-Yutani');
      expect(retrieved?.is_active).toBe(true);
    });

    it('should return null when retrieving a non-existent UUID', async () => {
      const nonExistentId = 'org-uuid-does-not-exist';
      const result = await getOrganizationById(nonExistentId);
      expect(result).toBeNull();
    });

    it('should successfully update organization details dynamically', async () => {
      const org = await createOrganization('Tyrell Corp', 'starter');

      const apiKey = generateApiKey();
      const hash = hashApiKey(apiKey);

      const updated = await updateOrganization(org.id, {
        plan_tier: 'premium',
        api_key_hash: hash,
      });

      expect(updated).toBeDefined();
      expect(updated.id).toBe(org.id);
    });

    it('should soft-deactivate an organization cleanly (is_active = false)', async () => {
      const org = await createOrganization('Umbrella Corp', 'starter');
      await deactivateOrganization(org.id);

      const retrieved = await getOrganizationById(org.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.is_active).toBe(false);
    });
  });
});
