/* eslint-disable @typescript-eslint/ban-ts-comment */
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { env } from '../src/config/env.js';
import { encrypt, decrypt } from '../src/utils/encryption.js';

// Local mock database state
let mockUsers: any[] = [];
let mockOrgs: any[] = [];
let mockAuditLogs: any[] = [];
const redisStore = new Map<string, string>();

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

      // Check database health
      if (sql === 'select 1') {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      // Fetch user by id
      if (sql.startsWith('select * from users where id = $1')) {
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

      // Save user mfa details (verifyAndEnableMFA or disableMFA)
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

      if (sql.startsWith('update users set mfa_secret = null, mfa_enabled = false')) {
        const id = p[0];
        const idx = mockUsers.findIndex((u) => u.id === id);
        if (idx !== -1) {
          mockUsers[idx].mfa_secret = null;
          mockUsers[idx].mfa_enabled = false;
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      // Insert audit logs
      if (sql.startsWith('insert into audit_logs')) {
        mockAuditLogs.push({ id: `audit-uuid-${Date.now()}` });
        return Promise.resolve({ rows: [], rowCount: 1 });
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

// Now import target services
import { MfaService, InvalidMFACodeError } from '../src/modules/auth/mfa.service.js';

describe('TruthShield Two-Factor Authentication & Encryption Suite', () => {
  let userId: string;
  let rawPasswordHash: string;

  beforeEach(async () => {
    // Reset state
    mockUsers = [];
    mockOrgs = [];
    mockAuditLogs = [];
    redisStore.clear();

    // Setup active mock org
    const org = { id: 'org-uuid-1', name: 'Security Corp' };
    mockOrgs.push(org);

    // Setup active mock user with a hashed password
    rawPasswordHash = await bcrypt.hash('SecurePassWord123!', 12);
    const user = {
      id: 'user-uuid-1',
      org_id: org.id,
      email: 'sec@truthshield.ai',
      password_hash: rawPasswordHash,
      role: 'admin',
      mfa_secret: null,
      mfa_enabled: false,
      last_login: null,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    mockUsers.push(user);
    userId = user.id;
  });

  describe('Symmetric AES-256-GCM Encryption Round-trip', () => {
    it('should successfully encrypt a text string and decrypt it cleanly', () => {
      const plainText = 'ts_otp_secret_value_12345';
      const encrypted = encrypt(plainText);

      // Verify structure IV:AuthTag:Ciphertext
      expect(encrypted).not.toBe(plainText);
      expect(encrypted.split(':').length).toBe(3);

      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plainText);
    });

    it('should throw an error when attempting to decrypt invalid structures', () => {
      expect(() => decrypt('invalid-string')).toThrow();
    });
  });

  describe('MFA Setup Operations', () => {
    it('should setupMFA returning a valid QR base64 code and 8 backup codes of length 10', async () => {
      const result = await MfaService.setupMFA(userId);

      expect(result.secret).toBeDefined();
      expect(result.qrCodeDataURL).toContain('data:image/png;base64,');
      expect(result.backupCodes.length).toBe(8);

      result.backupCodes.forEach((code) => {
        expect(code.length).toBe(10);
        expect(/^[A-Za-z0-9]+$/.test(code)).toBe(true);
      });

      // Verify secret stored in Redis setup cache
      const cachedSecret = await redisStore.get(`mfa_setup:${userId}`);
      expect(cachedSecret).toBe(result.secret);
    });
  });

  describe('MFA Verification and Onboarding Activation', () => {
    it('should successfully verify and enable MFA given a correct TOTP code', async () => {
      const mfaSetup = await MfaService.setupMFA(userId);

      // Generate correct code using otplib
      const totpCode = authenticator.generate(mfaSetup.secret);

      await MfaService.verifyAndEnableMFA(userId, totpCode);

      // Verify db changes
      const user = mockUsers.find((u) => u.id === userId);
      expect(user.mfa_enabled).toBe(true);
      expect(user.mfa_secret).toBeDefined();

      // Verify decryption returns the setup secret
      const decryptedSecret = decrypt(user.mfa_secret);
      expect(decryptedSecret).toBe(mfaSetup.secret);
    });

    it('should reject verified setup and throw InvalidMFACodeError given a wrong TOTP code', async () => {
      await MfaService.setupMFA(userId);

      await expect(
        MfaService.verifyAndEnableMFA(userId, '000000'), // invalid code
      ).rejects.toThrow(InvalidMFACodeError);

      const user = mockUsers.find((u) => u.id === userId);
      expect(user.mfa_enabled).toBe(false);
    });
  });

  describe('MFA Login Verification & Transition Challenges', () => {
    let mfaSecret: string;

    beforeEach(async () => {
      // Pre-enable MFA on the user
      mfaSecret = authenticator.generateSecret();
      const user = mockUsers.find((u) => u.id === userId);
      user.mfa_secret = encrypt(mfaSecret);
      user.mfa_enabled = true;
    });

    it('should verify MFA logins and return access tokens upon submitting a valid code', async () => {
      const tempToken = jwt.sign(
        { userId, orgId: 'org-uuid-1', role: 'admin', mfaTemp: true },
        env.JWT_SECRET,
        { expiresIn: '5m' as any },
      );

      const totpCode = authenticator.generate(mfaSecret);
      const tokens = await MfaService.verifyMFALogin(tempToken, totpCode);

      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toBeDefined();
    });

    it('should temporarily lock accounts in Redis for 15 minutes after 3 consecutive failures', async () => {
      const tempToken = jwt.sign(
        { userId, orgId: 'org-uuid-1', role: 'admin', mfaTemp: true },
        env.JWT_SECRET,
        { expiresIn: '5m' as any },
      );

      // Attempt 1: Fail
      await expect(MfaService.verifyMFALogin(tempToken, '000000')).rejects.toThrow(
        InvalidMFACodeError,
      );
      // Attempt 2: Fail
      await expect(MfaService.verifyMFALogin(tempToken, '000000')).rejects.toThrow(
        InvalidMFACodeError,
      );

      // Attempt 3: Triggers lock
      await expect(MfaService.verifyMFALogin(tempToken, '000000')).rejects.toThrow(
        /locked due to too many failed/,
      );

      // Attempt 4: Blocked immediately
      await expect(MfaService.verifyMFALogin(tempToken, '000000')).rejects.toThrow(
        /locked due to too many failed/,
      );
    });
  });

  describe('MFA Deactivations & Double-Guards', () => {
    let mfaSecret: string;

    beforeEach(async () => {
      mfaSecret = authenticator.generateSecret();
      const user = mockUsers.find((u) => u.id === userId);
      user.mfa_secret = encrypt(mfaSecret);
      user.mfa_enabled = true;
    });

    it('should deactivate MFA only if BOTH password and TOTP are valid', async () => {
      const totpCode = authenticator.generate(mfaSecret);

      // 1. Rejects invalid password
      await expect(
        MfaService.disableMFA(userId, totpCode, 'IncorrectPassword123!'),
      ).rejects.toThrow(/Invalid password/);

      // 2. Rejects invalid code
      await expect(MfaService.disableMFA(userId, '000000', 'SecurePassWord123!')).rejects.toThrow(
        InvalidMFACodeError,
      );

      // 3. Succeeds with correct inputs
      await MfaService.disableMFA(userId, totpCode, 'SecurePassWord123!');

      const user = mockUsers.find((u) => u.id === userId);
      expect(user.mfa_enabled).toBe(false);
      expect(user.mfa_secret).toBeNull();
    });
  });
});
