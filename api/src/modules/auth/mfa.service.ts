import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/error.js';
import { query } from '../../shared/database/pool.js';
import { redis } from '../../shared/redis/index.js';
import { logger } from '../../utils/logger.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { TokenPair } from './auth.types.js';
import { generateTokenPair } from './token.service.js';

// Custom Error Class to identify invalid MFA code failures
export class InvalidMFACodeError extends AppError {
  constructor(message = 'Invalid MFA code') {
    super(message, 400);
    this.name = 'InvalidMFACodeError';
  }
}

// Set default authenticator options to allow 1 step window (30-second drift buffer)
authenticator.options = { window: 1 };

/**
 * Generates 8 alphanumeric backup codes (10 characters long).
 */
function generateBackupCodes(): string[] {
  const codes: string[] = [];
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let c = 0; c < 8; c++) {
    let code = '';
    for (let i = 0; i < 10; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    codes.push(code);
  }
  return codes;
}

/**
 * Hashes a backup code string using SHA-256.
 */
function hashBackupCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export class MfaService {
  /**
   * Initializes Two-Factor Authentication onboarding.
   */
  static async setupMFA(
    userId: string,
  ): Promise<{ secret: string; qrCodeDataURL: string; backupCodes: string[] }> {
    // 1. Fetch user to verify active account
    const userRes = await query('SELECT email FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];
    if (!user) {
      throw new AppError('User not found', 404);
    }

    // 2. Generate TOTP secret
    const secret = authenticator.generateSecret();

    // 3. Store temporarily in Redis (10 minutes TTL)
    await redis.setex(`mfa_setup:${userId}`, 600, secret);

    // 4. Generate QR code Data URL
    const otpauth = authenticator.keyuri(user.email, env.TOTP_ISSUER || 'TruthShieldAI', secret);
    const qrCodeDataURL = await QRCode.toDataURL(otpauth);

    // 5. Generate 8 backup codes and cache their hashes temporarily
    const backupCodes = generateBackupCodes();
    const hashedCodes = backupCodes.map((code) => hashBackupCode(code));
    await redis.setex(`mfa:temp_backup_codes:${userId}`, 600, JSON.stringify(hashedCodes));

    logger.info(`MFA setup initiated for user: ${userId}`);

    return {
      secret,
      qrCodeDataURL,
      backupCodes,
    };
  }

  /**
   * Validates and enables Two-Factor Authentication.
   */
  static async verifyAndEnableMFA(userId: string, totpCode: string): Promise<void> {
    // 1. Fetch temporary secret from Redis
    const tempSecret = await redis.get(`mfa_setup:${userId}`);
    if (!tempSecret) {
      throw new AppError('MFA setup session has expired. Please restart setup.', 400);
    }

    // 2. Verify OTP token
    const isValid = authenticator.check(totpCode, tempSecret);
    if (!isValid) {
      throw new InvalidMFACodeError();
    }

    // 3. Encrypt secret and update database
    const encryptedSecret = encrypt(tempSecret);
    await query(
      'UPDATE users SET mfa_secret = $1, mfa_enabled = true, updated_at = NOW() WHERE id = $2',
      [encryptedSecret, userId],
    );

    // 4. Finalize backup codes activation in Redis
    const tempBackup = await redis.get(`mfa:temp_backup_codes:${userId}`);
    if (tempBackup) {
      await redis.set(`mfa:backup_codes:${userId}`, tempBackup);
    }

    // 5. Delete temporary Redis credentials
    await redis.del(`mfa_setup:${userId}`);
    await redis.del(`mfa:temp_backup_codes:${userId}`);

    // 6. Log audit action
    const userRes = await query('SELECT org_id FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];
    if (user) {
      await query(
        `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.org_id, userId, 'MFA_ENABLED', 'users', userId],
      );
    }

    logger.info(`MFA successfully activated for user: ${userId}`);
  }

  /**
   * Completes Two-Factor Authentication during login using a temporary token.
   */
  static async verifyMFALogin(tempToken: string, totpCode: string): Promise<TokenPair> {
    // 1. Verify temporary transition JWT
    let payload: any;
    try {
      payload = jwt.verify(tempToken, env.JWT_SECRET);
      if (!payload.mfaTemp) {
        throw new Error();
      }
    } catch {
      throw new AppError('Invalid or expired MFA session token', 401);
    }

    const { userId } = payload;

    // 2. Check Redis brute-force lock state (Account Lock checking)
    const lockKey = `mfa:lock:${userId}`;
    const isLocked = await redis.get(lockKey);
    if (isLocked) {
      throw new AppError(
        'Account is temporarily locked due to too many failed MFA attempts. Please try again in 15 minutes.',
        423,
      );
    }

    // 3. Fetch user and decrypt MFA secret
    const userRes = await query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    if (!user || !user.mfa_secret) {
      throw new AppError('MFA is not configured for this user', 400);
    }

    const decryptedSecret = decrypt(user.mfa_secret);

    // 4. Verify TOTP code (or fallback to backup codes!)
    let isValid = authenticator.check(totpCode, decryptedSecret);

    // Fallback: Check backup codes if TOTP fails
    if (!isValid) {
      const backupCodesJson = await redis.get(`mfa:backup_codes:${userId}`);
      if (backupCodesJson) {
        const hashedBackupCodes: string[] = JSON.parse(backupCodesJson);
        const hashedInput = hashBackupCode(totpCode);
        const codeIndex = hashedBackupCodes.indexOf(hashedInput);

        if (codeIndex !== -1) {
          isValid = true;
          // Consume the backup code (remove it so it can be used once only!)
          hashedBackupCodes.splice(codeIndex, 1);
          await redis.set(`mfa:backup_codes:${userId}`, JSON.stringify(hashedBackupCodes));
          logger.info(`Backup code consumed for user: ${userId}`);
        }
      }
    }

    // 5. Handle verification failure (locks after 3 failed attempts)
    if (!isValid) {
      const failedAttemptsKey = `mfa:failed_attempts:${userId}`;
      const failedCount = await redis.incr(failedAttemptsKey);
      await redis.expire(failedAttemptsKey, 900); // 15-minute window

      if (failedCount >= 3) {
        // Trigger 15-minute account lock
        await redis.setex(lockKey, 900, 'locked');
        await redis.del(failedAttemptsKey);
        throw new AppError(
          'Account is temporarily locked due to too many failed MFA attempts. Please try again in 15 minutes.',
          423,
        );
      }

      throw new InvalidMFACodeError();
    }

    // 6. Success: Clear lock trackers
    await redis.del(`mfa:failed_attempts:${userId}`);

    // 7. Write audit log
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.org_id, user.id, 'MFA_LOGIN_SUCCESS', 'users', user.id],
    );

    // 8. Return full session credentials
    return generateTokenPair({
      userId: user.id,
      orgId: user.org_id,
      role: user.role,
    });
  }

  /**
   * Deactivates Two-Factor Authentication. Requires both a valid password AND TOTP code.
   */
  static async disableMFA(userId: string, totpCode: string, password: string): Promise<void> {
    // 1. Fetch user credentials
    const userRes = await query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    if (!user || !user.mfa_secret) {
      throw new AppError('MFA is not enabled on this account', 400);
    }

    // 2. Validate user password
    const isPasswordMatch = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordMatch) {
      throw new AppError('Invalid password', 401);
    }

    // 3. Verify TOTP code
    const decryptedSecret = decrypt(user.mfa_secret);
    const isValid = authenticator.check(totpCode, decryptedSecret);
    if (!isValid) {
      throw new InvalidMFACodeError();
    }

    // 4. Update database
    await query(
      'UPDATE users SET mfa_secret = NULL, mfa_enabled = false, updated_at = NOW() WHERE id = $1',
      [userId],
    );

    // 5. Remove backup codes from Redis
    await redis.del(`mfa:backup_codes:${userId}`);

    // 6. Write audit log
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.org_id, userId, 'MFA_DISABLED', 'users', userId],
    );

    logger.info(`MFA successfully disabled for user: ${userId}`);
  }
}
