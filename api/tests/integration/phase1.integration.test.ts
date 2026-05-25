/* eslint-disable @typescript-eslint/ban-ts-comment */
import request from 'supertest';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { env } from '../../src/config/env.js';

// Local mock database state
let mockUsers: any[] = [];
let mockOrgs: any[] = [];
let mockAuditLogs: any[] = [];
const redisStore = new Map<string, string>();

// Mock express-rate-limit to simulate rate limiters
jest.mock('express-rate-limit', () => {
  const actualRateLimit = jest.requireActual('express-rate-limit') as any;
  return jest.fn().mockImplementation((options: any) => {
    // login rate limiter (max 5) - we keep it at 5 to trigger 429 after 5 failed attempts
    if (options && options.max === 5) {
      return actualRateLimit(options);
    }
    // For other limiters, allow higher threshold during test runs
    return actualRateLimit({
      ...options,
      max: 100,
    });
  });
});

// Mock DB index health endpoints
jest.mock('../../src/shared/database/index.js', () => {
  return {
    checkDatabaseHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
    query: jest.fn().mockImplementation(((text: any) => {
      const sql = (text || '').trim().toLowerCase();

      if (sql.startsWith('select * from audit_logs')) {
        return Promise.resolve({ rows: mockAuditLogs, rowCount: mockAuditLogs.length });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }) as any),
  };
});

// Mock DB pool layer
jest.mock('../../src/shared/database/pool.js', () => {
  return {
    pool: {
      connect: jest.fn().mockImplementation(() =>
        Promise.resolve({
          query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
          release: jest.fn(),
        })
      ),
      end: jest.fn().mockImplementation(() => Promise.resolve()),
    },
    testConnection: jest.fn().mockImplementation(() => Promise.resolve()),
    query: jest.fn().mockImplementation(((text: any, params?: any[]) => {
      const sql = (text || '').trim().toLowerCase();
      const p = params || [];

      // database health check
      if (sql === 'select 1') {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      // create organization
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

      // audit logs
      if (sql.startsWith('insert into audit_logs')) {
        const orgId = p[0];
        const userId = p[1];
        const action = p[2];
        const resourceType = p[3] || 'users';
        const resourceId = p[4];
        const newLog = {
          id: `log-uuid-${Date.now()}`,
          org_id: orgId,
          user_id: userId,
          action,
          resource_type: resourceType,
          resource_id: resourceId,
          created_at: new Date(),
        };
        mockAuditLogs.push(newLog);
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

      // Fetch user by id
      if (sql.startsWith('select * from users where id = $1')) {
        const id = p[0];
        const user = mockUsers.find((u) => u.id === id) || null;
        return Promise.resolve({ rows: user ? [user] : [], rowCount: user ? 1 : 0 });
      }

      // Fetch user for refresh tokens
      if (sql.startsWith('select id, org_id, role, is_active from users where id = $1')) {
        const id = p[0];
        const user = mockUsers.find((u) => u.id === id) || null;
        return Promise.resolve({ rows: user ? [user] : [], rowCount: user ? 1 : 0 });
      }

      // Fetch user email for setupMFA
      if (sql.startsWith('select email from users where id = $1')) {
        const id = p[0];
        const user = mockUsers.find((u) => u.id === id) || null;
        return Promise.resolve({ rows: user ? [user] : [], rowCount: user ? 1 : 0 });
      }

      // Fetch user org_id
      if (sql.startsWith('select org_id from users where id = $1')) {
        const id = p[0];
        const user = mockUsers.find((u) => u.id === id) || null;
        return Promise.resolve({ rows: user ? [user] : [], rowCount: user ? 1 : 0 });
      }

      // Update user mfa status
      if (sql.startsWith('update users set mfa_secret = $1, mfa_enabled = true')) {
        const secret = p[0];
        const id = p[1];
        const idx = mockUsers.findIndex((u) => u.id === id);
        if (idx !== -1) {
          mockUsers[idx].mfa_secret = secret;
          mockUsers[idx].mfa_enabled = true;
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      // Direct query to audit_logs
      if (sql.startsWith('select * from audit_logs')) {
        return Promise.resolve({ rows: mockAuditLogs, rowCount: mockAuditLogs.length });
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
            const orgId = p[0];
            const userId = p[1];
            const action = p[2];
            const resourceType = p[3] || 'users';
            const resourceId = p[4];
            const newLog = {
              id: `log-uuid-${Date.now()}`,
              org_id: orgId,
              user_id: userId,
              action,
              resource_type: resourceType,
              resource_id: resourceId,
              created_at: new Date(),
            };
            mockAuditLogs.push(newLog);
            return Promise.resolve({ rows: [], rowCount: 1 });
          }

          return Promise.resolve({ rows: [], rowCount: 0 });
        }) as any),
      };
      return callback(mockClient as any);
    }) as any),
  };
});

// Mock Redis Layer
jest.mock('../../src/shared/redis/index.js', () => {
  return {
    redis: {
      get: jest.fn().mockImplementation(((key: any) => Promise.resolve(redisStore.get(key) || null)) as any),
      set: jest.fn().mockImplementation(((key: any, val: any) => {
        redisStore.set(key, val);
        return Promise.resolve('OK');
      }) as any),
      setex: jest.fn().mockImplementation(((key: any, _ttl: any, val: any) => {
        redisStore.set(key, val);
        return Promise.resolve('OK');
      }) as any),
      del: jest.fn().mockImplementation(((key: any) => {
        redisStore.delete(key);
        return Promise.resolve(1);
      }) as any),
      incr: jest.fn().mockImplementation(((key: any) => {
        const val = parseInt(redisStore.get(key) || '0', 10) + 1;
        redisStore.set(key, val.toString());
        return Promise.resolve(val);
      }) as any),
      expire: jest.fn().mockImplementation((() => Promise.resolve(1)) as any),
      ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
      quit: jest.fn().mockImplementation(() => Promise.resolve()),
    },
    checkRedisHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
  };
});

import { app } from '../../src/app.js';
import { query } from '../../src/shared/database/pool.js';

describe('TruthShield Phase 1 End-to-End Master Integration Journeys', () => {
  beforeEach(() => {
    mockUsers = [];
    mockOrgs = [];
    mockAuditLogs = [];
    redisStore.clear();
  });

  describe('Journey 1 — New Customer Onboarding', () => {
    it('should successfully register, fetch health status, rotate tokens, logout, and prevent expired tokens', async () => {
      // 1. POST /auth/register with valid data -> expect 201, tokens returned, org created
      const registerRes = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'journey1@truthshield.ai',
          password: 'SecurePassWord123!',
          orgName: 'Journey One Org',
        });

      expect(registerRes.status).toBe(201);
      expect(registerRes.body.tokens).toBeDefined();
      expect(registerRes.body.tokens.accessToken).toBeDefined();
      expect(registerRes.body.tokens.refreshToken).toBeDefined();
      expect(registerRes.body.org.name).toBe('Journey One Org');
      
      const { accessToken, refreshToken } = registerRes.body.tokens;

      // 2. Use access token to GET /health -> expect 200
      const healthRes = await request(app)
        .get('/health')
        .set('Authorization', `Bearer ${accessToken}`);
      
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.status).toBe('ok');

      // 3. Access token expires simulation -> POST /auth/refresh -> expect new token pair
      const refreshRes = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken });
      
      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.accessToken).toBeDefined();
      expect(refreshRes.body.refreshToken).toBeDefined();

      const newRefreshToken = refreshRes.body.refreshToken;

      // 4. POST /auth/logout -> expect 200, refresh token invalidated
      const logoutRes = await request(app)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: newRefreshToken });
      
      expect(logoutRes.status).toBe(200);

      // 5. Try to use old refresh token -> expect 401
      const expiredRefreshRes = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: newRefreshToken });
      
      expect(expiredRefreshRes.status).toBe(401);
    });
  });

  describe('Journey 2 — MFA Setup & Challenge Logins', () => {
    it('should complete MFA onboarding and log in successfully with challenge transitions', async () => {
      // 1. Register new user
      const registerRes = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'journey2@truthshield.ai',
          password: 'SecurePassWord123!',
          orgName: 'Journey Two Org',
        });
      
      const userUuid = registerRes.body.user.id;
      const accessToken = registerRes.body.tokens.accessToken;

      // 2. POST /auth/mfa/setup -> expect QR code and backup codes
      const setupRes = await request(app)
        .post('/api/v1/auth/mfa/setup')
        .set('Authorization', `Bearer ${accessToken}`);
      
      expect(setupRes.status).toBe(200);
      expect(setupRes.body.secret).toBeDefined();
      expect(setupRes.body.qrCodeDataURL).toContain('data:image/png;base64,');
      expect(setupRes.body.backupCodes.length).toBe(8);

      const mfaSecret = setupRes.body.secret;

      // 3. POST /auth/mfa/verify-setup with valid TOTP -> expect MFA enabled
      const totpCode = authenticator.generate(mfaSecret);
      const verifyRes = await request(app)
        .post('/api/v1/auth/mfa/verify-setup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ totpCode });
      
      expect(verifyRes.status).toBe(200);
      
      // Verify in DB state
      const userObj = mockUsers.find((u) => u.id === userUuid);
      expect(userObj.mfa_enabled).toBe(true);

      // 4. POST /auth/logout
      await request(app)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: registerRes.body.tokens.refreshToken });

      // 5. POST /auth/login -> expect { requiresMFA: true, tempToken }
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'journey2@truthshield.ai',
          password: 'SecurePassWord123!',
        });
      
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.requiresMFA).toBe(true);
      expect(loginRes.body.tempToken).toBeDefined();

      const tempToken = loginRes.body.tempToken;

      // 6. POST /auth/mfa/login with valid TOTP -> expect full token pair
      const validCode = authenticator.generate(mfaSecret);
      const mfaLoginRes = await request(app)
        .post('/api/v1/auth/mfa/login')
        .send({
          tempToken,
          totpCode: validCode,
        });
      
      expect(mfaLoginRes.status).toBe(200);
      expect(mfaLoginRes.body.tokens).toBeDefined();
      expect(mfaLoginRes.body.tokens.accessToken).toBeDefined();
    });
  });

  describe('Journey 4 — System Audit Trails', () => {
    it('should generate complete, queryable audit events throughout the user lifecycle', async () => {
      // 1. Register a user
      const registerRes = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'audit@truthshield.ai',
          password: 'SecurePassWord123!',
          orgName: 'Audit Corp',
        });
      
      const accessToken = registerRes.body.tokens.accessToken;

      // 2. Login as that user
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({
          email: 'audit@truthshield.ai',
          password: 'SecurePassWord123!',
        });
      
      expect(loginRes.status).toBe(200);

      // 3. Setup and Enable MFA
      const setupRes = await request(app)
        .post('/api/v1/auth/mfa/setup')
        .set('Authorization', `Bearer ${accessToken}`);
      
      const mfaSecret = setupRes.body.secret;
      const totpCode = authenticator.generate(mfaSecret);
      
      const verifyRes = await request(app)
        .post('/api/v1/auth/mfa/verify-setup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ totpCode });
      
      expect(verifyRes.status).toBe(200);

      // 4. Query audit_logs table directly -> confirm entries exist for: USER_REGISTERED, USER_LOGIN, MFA_ENABLED
      const auditQuery = await query('SELECT * FROM audit_logs ORDER BY created_at ASC');
      
      expect(auditQuery.rows.length).toBeGreaterThanOrEqual(3);
      
      const actions = auditQuery.rows.map((row: any) => row.action);
      expect(actions).toContain('USER_REGISTERED');
      expect(actions).toContain('USER_LOGIN');
      expect(actions).toContain('MFA_ENABLED');
    });
  });

  describe('Journey 3 — Security & Access Boundaries', () => {
    it('should correctly enforce roles, schema strengths, email uniqueness, and rate limits', async () => {
      // 1. Try to access any protected route without token -> 401
      const protectedRes = await request(app).get('/api/v1/users/me');
      expect(protectedRes.status).toBe(401);

      // 2. Try to access admin route as viewer role -> 403
      // We will register a user as 'viewer'
      const org = { id: 'org-uuid-9', name: 'Boundary Corp' };
      mockOrgs.push(org);
      const hashedPw = await bcrypt.hash('SecurePassWord123!', 12);
      const viewerUser = {
        id: 'user-uuid-viewer',
        org_id: org.id,
        email: 'viewer@truthshield.ai',
        password_hash: hashedPw,
        role: 'viewer', // viewer role
        mfa_secret: null,
        mfa_enabled: false,
        last_login: null,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      };
      mockUsers.push(viewerUser);

      // Sign viewer JWT token
      const viewerAccessToken = jwt.sign(
        { userId: viewerUser.id, orgId: viewerUser.org_id, role: viewerUser.role },
        env.JWT_SECRET,
        { expiresIn: '15m' }
      );

      // POST /organizations requires super-admin role (not viewer!)
      const adminRouteRes = await request(app)
        .post('/api/v1/organizations')
        .set('Authorization', `Bearer ${viewerAccessToken}`)
        .send({ name: 'New Org', planTier: 'enterprise' });
      
      expect(adminRouteRes.status).toBe(403);

      // 3. Exceed login rate limit -> 429
      const rateLimitAttempts = [];
      for (let i = 0; i < 6; i++) {
        rateLimitAttempts.push(
          request(app)
            .post('/api/v1/auth/login')
            .send({ email: 'rate@truthshield.ai', password: 'IncorrectPassword!' })
        );
      }
      const results = await Promise.all(rateLimitAttempts);
      const statuses = results.map((r) => r.status);
      expect(statuses).toContain(429);

      // 4. Register with weak password -> 400 with field-level validation errors
      const weakRegisterRes = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'weakpass@truthshield.ai',
          password: '123', // weak password
          orgName: 'Weak Corp',
        });
      expect(weakRegisterRes.status).toBe(400);

      // 5. Register with duplicate email -> 409
      await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'dup@truthshield.ai',
          password: 'SecurePassWord123!',
          orgName: 'First Corp',
        });
      
      const dupRegisterRes = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: 'dup@truthshield.ai',
          password: 'SecurePassWord123!',
          orgName: 'Second Corp',
        });
      expect(dupRegisterRes.status).toBe(409);
    });
  });
});
