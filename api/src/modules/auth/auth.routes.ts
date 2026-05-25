import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { AuthService } from './auth.service.js';
import { refreshTokens } from './token.service.js';
import { MfaService } from './mfa.service.js';
import { redis } from '../../shared/redis/index.js';
import { AppError } from '../../middleware/error.js';
import { authenticate } from '../../middleware/authenticate.js';

const router = Router();

// Rate limiter policy for Login attempts (Max 5 per 15 minutes)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: 'Too many login attempts, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter policy for Registration attempts (Max 3 per hour)
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { message: 'Too many registration attempts, please try again after an hour' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Express validator rules for User registration
const validateRegister = [
  body('email').isEmail().withMessage('Invalid email format'),
  body('password').isLength({ min: 12 }).withMessage('Password must be at least 12 characters'),
  body('orgName').notEmpty().withMessage('Organization name is required'),
  (req: Request, res: Response, next: NextFunction): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }
    next();
  },
];

// Express validator rules for User login
const validateLogin = [
  body('email').isEmail().withMessage('Invalid email format'),
  body('password').notEmpty().withMessage('Password is required'),
  (req: Request, res: Response, next: NextFunction): void => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }
    next();
  },
];

// POST /auth/register - Register a new user + organization domain
router.post(
  '/register',
  registerLimiter,
  validateRegister,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email, password, orgName } = req.body;
      const result = await AuthService.register({ email, password, orgName });
      res.status(201).json({
        user: {
          id: result.user.id,
          org_id: result.user.org_id,
          email: result.user.email,
          role: result.user.role,
        },
        org: result.org,
        tokens: result.tokens,
      });
    } catch (error) {
      next(error);
    }
  },
);

// POST /auth/login - User credential authentication
router.post(
  '/login',
  loginLimiter,
  validateLogin,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email, password } = req.body;
      const ip = req.ip || '127.0.0.1';
      const userAgent = req.headers['user-agent'] || '';

      const result = await AuthService.login({ email, password }, ip, userAgent);

      if ('requiresMFA' in result) {
        res.status(200).json(result);
        return;
      }

      res.status(200).json({
        user: {
          id: result.user.id,
          org_id: result.user.org_id,
          email: result.user.email,
          role: result.user.role,
        },
        tokens: result.tokens,
      });
    } catch (error) {
      next(error);
    }
  },
);

// POST /auth/refresh - Accepts refreshToken to issue a fresh TokenPair
router.post('/refresh', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      throw new AppError('Refresh token is required', 400);
    }

    const tokens = await refreshTokens(refreshToken);
    res.status(200).json(tokens);
  } catch (error) {
    next(error);
  }
});

// POST /auth/logout - Invalidate access & refresh tokens
router.post('/logout', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      // blacklist refresh token in Redis with 7-day TTL (604,800 seconds)
      await redis.setex(`blacklist:refresh:${refreshToken}`, 604800, 'revoked');
    }

    // Optionally blacklist the bearer Access Token to trigger immediate revocation
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const accessToken = authHeader.substring(7).trim();
      await redis.setex(`blacklist:access:${accessToken}`, 900, 'revoked'); // 15 min TTL (900 seconds)
    }

    res.status(200).json({ message: 'Successfully logged out' });
  } catch (error) {
    next(error);
  }
});

/**
 * ============================================================================
 * TWO-FACTOR AUTHENTICATION ENDPOINTS (TOTP-BASED MFA)
 * ============================================================================
 */

// POST /auth/mfa/setup - Initialize Two-Factor Authentication configuration
router.post(
  '/mfa/setup',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const result = await MfaService.setupMFA(userId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
);

// POST /auth/mfa/verify-setup - Confirms and locks MFA registration
router.post(
  '/mfa/verify-setup',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const { totpCode } = req.body;

      if (!totpCode) {
        throw new AppError('TOTP code is required', 400);
      }

      await MfaService.verifyAndEnableMFA(userId, totpCode);
      res.status(200).json({ message: 'MFA enabled successfully' });
    } catch (error) {
      next(error);
    }
  },
);

// POST /auth/mfa/login - MFA Challenge Login verification
router.post(
  '/mfa/login',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { tempToken, totpCode } = req.body;

      if (!tempToken || !totpCode) {
        throw new AppError('Temporary token and TOTP code are required', 400);
      }

      const tokens = await MfaService.verifyMFALogin(tempToken, totpCode);
      res.status(200).json({ tokens });
    } catch (error) {
      next(error);
    }
  },
);

// POST /auth/mfa/disable - Securely deactivate Two-Factor Authentication
router.post(
  '/mfa/disable',
  authenticate,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const { totpCode, password } = req.body;

      if (!totpCode || !password) {
        throw new AppError('TOTP code and password are required', 400);
      }

      await MfaService.disableMFA(userId, totpCode, password);
      res.status(200).json({ message: 'MFA disabled successfully' });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
