import { Request, Response, NextFunction } from 'express';
import { redisClient } from '../shared/redis/redis.client.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { UAParser } from 'ua-parser-js';
import { authSlowDown } from './slowDown.js';

export interface AbuseCheckResult {
  blocked: boolean;
  reason?: string;
  threatScore: number;
}

export class AbuseDetector {
  async checkBannedIP(ip: string): Promise<boolean> {
    const isBanned = await redisClient.get(`ts:banned_ip:${ip}`);
    return !!isBanned;
  }

  checkSuspiciousUserAgent(userAgent: string): boolean {
    if (!userAgent || userAgent.trim() === '') return true;

    const ua = userAgent.toLowerCase();
    const suspiciousPatterns = [
      'sqlmap',
      'nikto',
      'masscan',
      'zgrab',
      'curl',
      'wget',
      'python-requests',
    ];

    for (const pattern of suspiciousPatterns) {
      if (ua.includes(pattern)) return true;
    }

    const parser = new UAParser(userAgent);
    const browser = parser.getBrowser();

    // Flag claiming to be a browser but missing version
    if (browser.name && !browser.version) {
      return true;
    }

    return false;
  }

  async checkRequestPattern(ip: string, endpoint: string): Promise<boolean> {
    const key = `ts:req_pattern:${ip}:${endpoint}`;
    const count = await redisClient.incr(key);

    if (count === 1) {
      await redisClient.expire(key, 3600); // 1 hour TTL
    }

    return count > (env.SUSPICIOUS_REQUEST_THRESHOLD || 50);
  }

  async banIP(ip: string, reason: string, hours: number): Promise<void> {
    const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    const value = JSON.stringify({ reason, bannedAt: new Date().toISOString(), expiresAt });

    await redisClient.setex(`ts:banned_ip:${ip}`, hours * 3600, value);
    logger.warn(`[AbuseDetector] IP banned: ${ip}, reason: ${reason}`);
  }

  calculateThreatScore(checks: {
    isBanned: boolean;
    suspiciousUA: boolean;
    suspiciousPattern: boolean;
    failedAuthAttempts: number;
  }): number {
    if (checks.isBanned) return 100;

    let score = 0;
    if (checks.suspiciousUA) score += 30;
    if (checks.suspiciousPattern) score += 40;
    if (checks.failedAuthAttempts > 10) score += 30;

    return Math.min(score, 100);
  }

  async checkRequest(req: Request): Promise<AbuseCheckResult> {
    const ip = req.ip || 'unknown';

    // Skip checking trusted IPs
    if (env.RATE_LIMIT_SKIP_TRUSTED_IPS) {
      const trusted = env.RATE_LIMIT_SKIP_TRUSTED_IPS.split(',').map((i) => i.trim());
      if (trusted.includes(ip)) {
        return { blocked: false, threatScore: 0 };
      }
    }

    const isBanned = await this.checkBannedIP(ip);
    if (isBanned) {
      return { blocked: true, reason: 'IP is banned', threatScore: 100 };
    }

    const suspiciousUA = this.checkSuspiciousUserAgent(req.headers['user-agent'] || '');
    const suspiciousPattern = await this.checkRequestPattern(ip, req.originalUrl);

    // Fetch failed auth attempts if on auth routes (mocked as 0 for global check here)
    const failedAuthAttempts = 0;

    const threatScore = this.calculateThreatScore({
      isBanned,
      suspiciousUA,
      suspiciousPattern,
      failedAuthAttempts,
    });

    if (threatScore > 80) {
      await this.banIP(ip, 'High threat score detected', env.ABUSE_BAN_DURATION_HOURS || 24);
      return { blocked: true, reason: 'High threat score', threatScore };
    }

    return { blocked: false, threatScore };
  }
}

const detector = new AbuseDetector();

export const abuseCheck = async (req: Request, res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV === 'test' && process.env.ENABLE_SECURITY_MIDDLEWARE !== 'true') {
    return next();
  }
  try {
    const result = await detector.checkRequest(req);

    if (result.blocked) {
      res.status(403).json({
        success: false,
        error: {
          code: 'IP_BANNED',
          message: 'Access denied due to suspicious activity.',
        },
      });
      return; // Do not call next()
    }

    if (result.threatScore >= 50 && result.threatScore <= 80) {
      // Add to slow-down queue
      return authSlowDown(req as any, res as any, next);
    }

    next();
  } catch (error) {
    logger.error(`[AbuseDetector] Error during check: ${(error as any).message}`);
    next(); // Fail open to not block legitimate traffic on error
  }
};
