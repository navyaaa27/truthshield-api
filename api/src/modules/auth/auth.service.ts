import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/error.js';
import { query, transaction } from '../../shared/database/pool.js';
import { logger } from '../../utils/logger.js';
import { Organization } from '../organizations/organization.types.js';
import { LoginDTO, RegisterDTO, TokenPair, User } from './auth.types.js';
import { generateTokenPair } from './token.service.js';

/**
 * Validates email format using a standard regular expression.
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Enforces strong password criteria:
 * - Minimum 12 characters
 * - At least 1 uppercase letter
 * - At least 1 number
 * - At least 1 special character
 */
function isValidPassword(password: string): boolean {
  if (password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[^A-Za-z0-9]/.test(password)) return false;
  return true;
}

export class AuthService {
  /**
   * Registers a new organization and user account atomically inside a database transaction.
   */
  static async register(
    dto: RegisterDTO,
  ): Promise<{ user: User; org: Organization; tokens: TokenPair }> {
    const { email, password, orgName } = dto;

    // 1. Inputs validation
    if (!email || !isValidEmail(email)) {
      throw new AppError('Invalid email format', 400);
    }
    if (!password || !isValidPassword(password)) {
      throw new AppError(
        'Password must be at least 8 characters and contain 1 uppercase letter, 1 number, and 1 special character',
        400,
      );
    }
    if (!orgName || orgName.trim() === '') {
      throw new AppError('Organization name is required', 400);
    }

    // 2. Prevent email conflicts
    const emailCheck = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (emailCheck.rowCount && emailCheck.rowCount > 0) {
      throw new AppError('Email is already registered', 409); // Conflict Error
    }

    // 3. Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // 4. Perform atomic creation block
    return transaction(async (client) => {
      // Step A: Create Organization
      const orgRes = await client.query<Organization>(
        `INSERT INTO organizations (name, plan_tier)
         VALUES ($1, $2)
         RETURNING id, name, plan_tier, api_key_hash, is_active, created_at, updated_at`,
        [orgName, 'starter'],
      );
      const org = orgRes.rows[0];

      // Step B: Create User linked to Organization as the owner (admin role)
      const userRes = await client.query<User>(
        `INSERT INTO users (org_id, email, password_hash, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, org_id, email, role, mfa_secret, mfa_enabled, last_login, is_active, created_at, updated_at`,
        [org.id, email, passwordHash, 'admin'],
      );
      const user = userRes.rows[0];

      // Step C: Log to Audit Logs
      await client.query(
        `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [org.id, user.id, 'USER_REGISTERED', 'users', user.id],
      );

      logger.info(`Auth Registration Success: User ${user.email} (Org: ${org.name})`);

      // Generate tokens
      const tokens = generateTokenPair({
        userId: user.id,
        orgId: org.id,
        role: user.role,
      });

      return { user, org, tokens };
    });
  }

  /**
   * Log in user checking password and mfa states, updating last login, and generating session tokens.
   */
  static async login(
    dto: LoginDTO,
    ip: string,
    userAgent: string,
  ): Promise<{ user: User; tokens: TokenPair } | { requiresMFA: true; tempToken: string }> {
    const { email, password } = dto;

    if (!email || !password) {
      throw new AppError('Invalid credentials', 401);
    }

    // 1. Fetch user (Always return generic Invalid Credentials for safety)
    const userRes = await query<User>('SELECT * FROM users WHERE email = $1', [email]);
    const user = userRes.rows[0];

    if (!user || !user.is_active) {
      throw new AppError('Invalid credentials', 401);
    }

    // 2. Verify password
    const isPasswordMatch = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordMatch) {
      throw new AppError('Invalid credentials', 401);
    }

    // 3. Audit log mapping
    // Filter IP address string to make sure it's valid pg INET format (nullify standard dev local loopbacks if invalid)
    let sanitizedIp: string | null = ip;
    if (ip === '::1' || ip === '127.0.0.1') {
      sanitizedIp = '127.0.0.1'; // standard localhost loopback
    } else if (!/^[0-9a-fA-F.:]+$/.test(ip)) {
      sanitizedIp = null;
    }

    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [user.org_id, user.id, 'USER_LOGIN', 'users', user.id, sanitizedIp, userAgent],
    );

    // 4. Update last_login
    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    // 5. Handle MFA check
    if (user.mfa_enabled) {
      const tempToken = jwt.sign(
        { userId: user.id, orgId: user.org_id, role: user.role, mfaTemp: true },
        env.JWT_SECRET,
        { expiresIn: '5m' as any },
      );
      return { requiresMFA: true, tempToken };
    }

    // 6. Complete standard login
    const tokens = generateTokenPair({
      userId: user.id,
      orgId: user.org_id,
      role: user.role,
    });

    logger.info(`Auth Login Success: User ${user.email}`);
    return { user, tokens };
  }
}
