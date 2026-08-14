process.env.ENABLE_SECURITY_MIDDLEWARE = 'true';

/* eslint-disable @typescript-eslint/ban-ts-comment */
import request from 'supertest';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

// Local mock database state
let mockOrgs: any[] = [];
let mockUsers: any[] = [];
let mockAuditLogs: any[] = [];
const redisStore = new Map<string, string>();

// Mock express-rate-limit dynamically before importing the app
jest.mock('express-rate-limit', () => {
  const actualRateLimit = jest.requireActual('express-rate-limit') as any;
  const mockFn = jest.fn().mockImplementation((options: any) => {
    // Increase the register limiter max to 100 to allow infinite registration tests
    if (options && options.windowMs === 60 * 60 * 1000) {
      return actualRateLimit({
        ...options,
        max: 100,
      });
    }
    // Keep login limiter max at 5 so the login rate limiting test passes cleanly
    return actualRateLimit(options);
  });
  (mockFn as any).rateLimit = mockFn;
  (mockFn as any).default = mockFn;
  return mockFn;
});

// Mock DB index health endpoints
jest.mock('../src/shared/database/index.js', () => {
  return {
    checkDatabaseHealth: (jest.fn() as any).mockResolvedValue({
      writePool: { connected: true, poolSize: 5, idleCount: 3, waitingCount: 0 },
      readPool: { connected: true, poolSize: 5, idleCount: 3, waitingCount: 0 },
      slowQueriesLastHour: 0,
    }),
    query: (jest.fn() as any).mockResolvedValue({ rows: [], rowCount: 0 }),
  };
});

// Mock DB and Redis modules before importing the app
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

      // check database health
      if (sql === 'select 1') {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      // Check if email already registered
      if (sql.startsWith('select id from users where email = $1')) {
        const email = p[0];
        const user = mockUsers.find((u) => u.email === email) || null;
        return Promise.resolve({ rows: user ? [user] : [], rowCount: user ? 1 : 0 });
      }

      // Get user by email (for login)
      if (sql.startsWith('select * from users where email = $1')) {
        const email = p[0];
        const user = mockUsers.find((u) => u.email === email) || null;
        return Promise.resolve({ rows: user ? [user] : [], rowCount: user ? 1 : 0 });
      }

      // Fetch user for refresh tokens
      if (sql.startsWith('select id, org_id, role, is_active from users where id = $1')) {
        const id = p[0];
        const user = mockUsers.find((u) => u.id === id) || null;
        return Promise.resolve({ rows: user ? [user] : [], rowCount: user ? 1 : 0 });
      }

      // Update last login
      if (sql.startsWith('update users set last_login = now()')) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      return Promise.resolve({ rows: [], rowCount: 0 });
    }) as any),
    transaction: jest.fn().mockImplementation(((callback: any) => {
      const mockClient = {
        query: jest.fn().mockImplementation(((text: any, params?: any[]) => {
          const sql = (text || '').trim().toLowerCase();
          const p = params || [];

          // create organization
          if (sql.startsWith('insert into organizations')) {
            const name = p[0];
            const newOrg = {
              id: `org-uuid-${Math.random().toString(36).substr(2, 9)}`,
              name,
              plan_tier: 'starter',
              api_key_hash: null,
              is_active: true,
              created_at: new Date(),
              updated_at: new Date(),
            };
            mockOrgs.push(newOrg);
            return Promise.resolve({ rows: [newOrg], rowCount: 1 });
          }

          // create user
          if (sql.startsWith('insert into users')) {
            const orgId = p[0];
            const email = p[1];
            const passwordHash = p[2];
            const role = p[3] || 'admin';
            const newUser = {
              id: `user-uuid-${Math.random().toString(36).substr(2, 9)}`,
              org_id: orgId,
              email,
              password_hash: passwordHash,
              role,
              mfa_secret: null,
              mfa_enabled: false,
              last_login: null,
              is_active: true,
              created_at: new Date(),
              updated_at: new Date(),
            };
            mockUsers.push(newUser);
            return Promise.resolve({ rows: [newUser], rowCount: 1 });
          }

          // audit logs
          if (sql.startsWith('insert into audit_logs')) {
            mockAuditLogs.push({ id: `log-uuid-${Date.now()}` });
            return Promise.resolve({ rows: [], rowCount: 1 });
          }

          return Promise.resolve({ rows: [], rowCount: 0 });
        }) as any),
      };
      return callback(mockClient as any);
    }) as any),
    writePool: {
      query: (jest.fn() as any).mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 }),
      totalCount: 5,
      idleCount: 3,
      waitingCount: 0,
      on: jest.fn(),
    } as any,
    readPool: {
      query: (jest.fn() as any).mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 }),
      totalCount: 5,
      idleCount: 3,
      waitingCount: 0,
      on: jest.fn(),
    } as any,
    getSlowQueriesLastHourCount: (jest.fn() as any).mockReturnValue(0),
    updatePoolMetrics: jest.fn(),
  } as any;
});

// Mock Redis Layer
jest.mock('../src/shared/redis/index.js', () => {
  return {
    redis: {
      get: jest
        .fn()
        .mockImplementation(((key: any) => Promise.resolve(redisStore.get(key) || null)) as any),
      set: jest.fn().mockImplementation(((key: any, val: any) => {
        redisStore.set(key, val);
        return Promise.resolve('OK');
      }) as any),
      setex: jest.fn().mockImplementation(((key: any, _ttl: any, val: any) => {
        redisStore.set(key, val);
        return Promise.resolve('OK');
      }) as any),
      ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
      quit: jest.fn().mockImplementation(() => Promise.resolve()),
    },
    checkRedisHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
  };
});

jest.mock('../src/shared/redis/redis.client.js', () => ({
  redisClient: {
    get: jest.fn().mockImplementation(((_key: any) => Promise.resolve(null)) as any),
    setex: jest
      .fn()
      .mockImplementation(((_key: any, _ttl: any, _val: any) => Promise.resolve('OK')) as any),
    del: jest.fn().mockImplementation(((_key: any) => Promise.resolve(1)) as any),
    keys: jest.fn().mockImplementation((() => Promise.resolve([])) as any),
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
        const val = parseInt(redisStore.get(key) || '0', 10) + 1;
        redisStore.set(key, val.toString());
        return Promise.resolve([val, 60]);
      }
      return Promise.resolve();
    }) as any),
    on: jest.fn(),
  },
  isRedisHealthy: jest.fn().mockImplementation(() => Promise.resolve(true)),
  getRedisLatency: jest.fn().mockImplementation(() => Promise.resolve(1)),
}));

// Now import the app
import { app } from '../src/app.js';

describe('TruthShield API Complete Authentication & Rate Limiting Integration Tests', () => {
  beforeEach(() => {
    // Reset databases and Redis stores
    mockOrgs = [];
    mockUsers = [];
    mockAuditLogs = [];
    redisStore.clear();
  });

  describe('GET /health Check', () => {
    it('should return 200 and healthy status when core services are functional', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
    });
  });

  describe('Authentication Workflow Integration Tests', () => {
    it('should successfully register a new user + org and return valid JWT tokens', async () => {
      const response = await request(app).post('/api/v1/auth/register').send({
        email: 'founder@truthshield.ai',
        password: 'SecurePassWord123!',
        orgName: 'TruthShield AI Corp',
      });

      expect(response.status).toBe(201);
      expect(response.body.user).toBeDefined();
      expect(response.body.user.email).toBe('founder@truthshield.ai');
      expect(response.body.user.role).toBe('admin');

      expect(response.body.org).toBeDefined();
      expect(response.body.org.name).toBe('TruthShield AI Corp');

      expect(response.body.tokens).toBeDefined();
      expect(response.body.tokens.accessToken).toBeDefined();
      expect(response.body.tokens.refreshToken).toBeDefined();
    });

    it('should successfully log in and return access tokens for valid credentials', async () => {
      // 1. Register account
      await request(app).post('/api/v1/auth/register').send({
        email: 'login@truthshield.ai',
        password: 'SecurePassWord123!',
        orgName: 'Login Corp',
      });

      // 2. Perform Login
      const response = await request(app).post('/api/v1/auth/login').send({
        email: 'login@truthshield.ai',
        password: 'SecurePassWord123!',
      });

      expect(response.status).toBe(200);
      expect(response.body.tokens).toBeDefined();
      expect(response.body.tokens.accessToken).toBeDefined();
      expect(response.body.tokens.refreshToken).toBeDefined();
    });

    it('should fail with a 401 and generic message for an incorrect password', async () => {
      // 1. Register account
      await request(app).post('/api/v1/auth/register').send({
        email: 'wrongpass@truthshield.ai',
        password: 'SecurePassWord123!',
        orgName: 'WrongPass Corp',
      });

      // 2. Login with wrong password
      const response = await request(app).post('/api/v1/auth/login').send({
        email: 'wrongpass@truthshield.ai',
        password: 'IncorrectPassword123!',
      });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Invalid credentials');
    });

    it('should return the exact same 401 error message for a non-existent email', async () => {
      const response = await request(app).post('/api/v1/auth/login').send({
        email: 'notregistered@truthshield.ai',
        password: 'SecurePassWord123!',
      });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe('Invalid credentials');
    });

    it('should successfully refresh access tokens using a valid refresh token', async () => {
      // 1. Register
      const registerRes = await request(app).post('/api/v1/auth/register').send({
        email: 'refresh@truthshield.ai',
        password: 'SecurePassWord123!',
        orgName: 'Refresh Corp',
      });

      const refreshToken = registerRes.body.tokens.refreshToken;

      // 2. Refresh tokens
      const response = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });

      expect(response.status).toBe(200);
      expect(response.body.accessToken).toBeDefined();
      expect(response.body.refreshToken).toBeDefined();
    });
  });

  describe('Route Access Protection', () => {
    it('should reject access to protected endpoints with a 401 if token is missing', async () => {
      const response = await request(app).get('/api/v1/users/me');
      expect(response.status).toBe(401);
    });

    it('should reject access to protected endpoints with a 401 if token is expired', async () => {
      // Generate a token signed with an expired timestamp (exp set to 1 hour ago)
      const expiredToken = jwt.sign(
        {
          userId: 'user-uuid-12345',
          orgId: 'org-uuid-12345',
          role: 'admin',
          exp: Math.floor(Date.now() / 1000) - 3600, // expired 1 hour ago
        },
        env.JWT_SECRET,
      );

      const response = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(response.status).toBe(401);
    });
  });

  describe('Rate Limiting System Protection', () => {
    it('should block login requests after exceeding the 5 attempts threshold', async () => {
      const attempts = [];
      for (let i = 0; i < 6; i++) {
        attempts.push(
          request(app).post('/api/v1/auth/login').send({
            email: 'ratelimit@truthshield.ai',
            password: 'WrongPassword123!',
          }),
        );
      }

      const results = await Promise.all(attempts);
      const statuses = results.map((r) => r.status);

      // Verify that at least one request failed with a 429 Too Many Requests code
      expect(statuses).toContain(429);
    });
  });

  afterAll(() => {
    delete process.env.ENABLE_SECURITY_MIDDLEWARE;
  });
});
