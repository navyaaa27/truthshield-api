import nodemailer from 'nodemailer';
import { query } from '../../shared/database/pool.js';
import { redisClient } from '../../shared/redis/redis.client.js';
import { logger } from '../../utils/logger.js';
import { PLAN_LIMITS } from './billing.service.js';
import { env } from '../../config/env.js';

export interface UsageSummary {
  jobsRun: number;
  jobsLimit: number;
  jobsRemaining: number;
  uploadsCount: number;
  uploadsLimit: number;
  apiCalls: number;
  reportsGenerated: number;
  periodStart: string;
  periodEnd: string;
  pctUsed: number;
}

export class UsageService {
  /**
   * Safe helper to send quota warning emails
   */
  static async sendQuotaWarningEmail(
    orgId: string,
    pct: number,
    currentUsage: number,
    limit: number,
  ): Promise<void> {
    try {
      const orgRes = await query(`SELECT name, source_metadata FROM organizations WHERE id = $1`, [
        orgId,
      ]);
      if (!orgRes.rowCount || orgRes.rowCount === 0) return;
      const org = orgRes.rows[0];
      const metadata = org.source_metadata || {};
      const recipient = metadata.notifications?.emailRecipient || `billing+${orgId}@truthshield.ai`;

      const transporter = nodemailer.createTransport({
        host: env.SMTP_HOST || 'localhost',
        port: env.SMTP_PORT || 587,
        secure: env.SMTP_PORT === 465,
        auth: env.SMTP_USER
          ? {
              user: env.SMTP_USER,
              pass: env.SMTP_PASS,
            }
          : undefined,
      });

      const subject = `[TruthShield] Warning: Quota usage at ${pct}% for ${org.name}`;
      const text = `Hello,\n\nYour organization ${org.name} has consumed ${currentUsage} out of ${limit} jobs (${pct}%).\nPlease upgrade your subscription to avoid disruption.\n\nBest,\nTruthShield Team`;

      await transporter.sendMail({
        from: env.SMTP_FROM || 'alerts@truthshield.ai',
        to: recipient,
        subject,
        text,
      });
      logger.info(`[UsageService] Quota warning email sent to ${recipient} (${pct}%)`);
    } catch (err: any) {
      logger.error(`[UsageService.sendQuotaWarningEmail] Failed to send email: ${err.message}`);
    }
  }

  /**
   * Resolves the current subscription period for an organization (creates DB usage row if missing)
   */
  private static async getOrCreateCurrentPeriod(orgId: string): Promise<{
    periodStart: Date;
    periodEnd: Date;
    planTier: string;
  }> {
    const subRes = await query(
      `SELECT plan_tier, current_period_start, current_period_end FROM subscriptions WHERE org_id = $1`,
      [orgId],
    );

    let planTier = 'starter';
    let periodStart = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000); // Default to middle of 30 days
    let periodEnd = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);

    if (subRes.rowCount && subRes.rowCount > 0 && subRes.rows[0].current_period_start) {
      planTier = subRes.rows[0].plan_tier;
      periodStart = new Date(subRes.rows[0].current_period_start);
      periodEnd = new Date(subRes.rows[0].current_period_end);
    }

    const limits = PLAN_LIMITS[planTier.toLowerCase()] || PLAN_LIMITS.starter;

    // Check if usage record already exists in DB
    const usageRes = await query(
      `SELECT id FROM usage_records 
       WHERE org_id = $1 AND period_start = $2`,
      [orgId, periodStart],
    );

    if (!usageRes.rowCount || usageRes.rowCount === 0) {
      await query(
        `INSERT INTO usage_records (org_id, period_start, period_end, jobs_limit)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [orgId, periodStart, periodEnd, limits.jobs],
      );
    }

    return { periodStart, periodEnd, planTier };
  }

  /**
   * Increments usage counters for jobs, uploads, api_calls, or reports
   */
  static async incrementUsage(
    orgId: string,
    metric: 'jobs' | 'uploads' | 'api_calls' | 'reports',
  ): Promise<void> {
    try {
      const { periodStart, planTier } = await this.getOrCreateCurrentPeriod(orgId);
      const periodStartIso = periodStart.toISOString();
      const redisKey = `usage:${orgId}:${metric}:${periodStartIso}`;

      // Increment Redis counter
      let count = 1;
      try {
        const val = await redisClient.incr(redisKey);
        await redisClient.expire(redisKey, 35 * 24 * 60 * 60); // 35 days expiry
        count = val;
      } catch (err: any) {
        logger.warn(
          `[UsageService.incrementUsage] Redis increment failed: ${err.message}. Relying on DB only.`,
        );
        // Fallback to database direct increment
        await query(
          `UPDATE usage_records
           SET jobs_run = jobs_run + CASE WHEN $1 = 'jobs' THEN 1 ELSE 0 END,
               uploads_count = uploads_count + CASE WHEN $1 = 'uploads' THEN 1 ELSE 0 END,
               api_calls = api_calls + CASE WHEN $1 = 'api_calls' THEN 1 ELSE 0 END,
               reports_generated = reports_generated + CASE WHEN $1 = 'reports' THEN 1 ELSE 0 END
           WHERE org_id = $2 AND period_start = $3`,
          [metric, orgId, periodStart],
        );
        return;
      }

      // Check threshold and limits for Jobs
      if (metric === 'jobs') {
        const limits = PLAN_LIMITS[planTier.toLowerCase()] || PLAN_LIMITS.starter;
        const limit = limits.jobs;
        const pct = (count / limit) * 100;

        // 80% Warning email (send exactly once per period)
        if (pct >= 80 && pct < 100) {
          const warningKey = `usage:${orgId}:warning_sent:80:${periodStartIso}`;
          const alreadySent = await redisClient.get(warningKey);
          if (!alreadySent) {
            await redisClient.setex(warningKey, 35 * 24 * 60 * 60, 'true');
            // Dispatch warning email async
            this.sendQuotaWarningEmail(orgId, 80, count, limit).catch(() => {});
          }
        }
      }
    } catch (error: any) {
      logger.error(`[UsageService.incrementUsage] Error: ${error.message}`);
    }
  }

  /**
   * Checks if an organization is allowed to run a job or perform an upload
   */
  static async checkUsageLimit(
    orgId: string,
    metric: 'jobs' | 'uploads',
  ): Promise<{ allowed: boolean; usage: number; limit: number }> {
    try {
      const { periodStart, planTier } = await this.getOrCreateCurrentPeriod(orgId);
      const limits = PLAN_LIMITS[planTier.toLowerCase()] || PLAN_LIMITS.starter;
      const limit = metric === 'jobs' ? limits.jobs : limits.uploads;

      let usage = 0;
      try {
        const redisKey = `usage:${orgId}:${metric}:${periodStart.toISOString()}`;
        const redisVal = await redisClient.get(redisKey);
        if (redisVal !== null) {
          usage = parseInt(redisVal, 10);
        } else {
          // If Redis key missing, check DB and seed Redis
          const dbRes = await query(
            `SELECT jobs_run, uploads_count FROM usage_records 
             WHERE org_id = $1 AND period_start = $2`,
            [orgId, periodStart],
          );
          if (dbRes.rowCount && dbRes.rowCount > 0) {
            usage = metric === 'jobs' ? dbRes.rows[0].jobs_run : dbRes.rows[0].uploads_count;
            // Seed Redis
            await redisClient.setex(redisKey, 35 * 24 * 60 * 60, usage.toString());
          }
        }
      } catch (redisErr: any) {
        logger.warn(
          `[UsageService.checkUsageLimit] Redis down: ${redisErr.message}. Falling back to DB.`,
        );
        const dbRes = await query(
          `SELECT jobs_run, uploads_count FROM usage_records 
           WHERE org_id = $1 AND period_start = $2`,
          [orgId, periodStart],
        );
        if (dbRes.rowCount && dbRes.rowCount > 0) {
          usage = metric === 'jobs' ? dbRes.rows[0].jobs_run : dbRes.rows[0].uploads_count;
        }
      }

      return {
        allowed: usage < limit,
        usage,
        limit,
      };
    } catch (err: any) {
      logger.error(`[UsageService.checkUsageLimit] Failure: ${err.message}`);
      return { allowed: true, usage: 0, limit: 100 }; // Fail open to not block customer during catastrophic errors
    }
  }

  /**
   * Flushes Redis usage counters to PostgreSQL (handles concurrency/deltas)
   */
  static async syncUsageToDatabase(): Promise<void> {
    try {
      let keys: string[] = [];
      try {
        keys = await redisClient.keys('usage:*:*:*');
      } catch (err: any) {
        logger.error(`[UsageService.syncUsageToDatabase] Redis keys lookup failed: ${err.message}`);
        return;
      }

      for (const key of keys) {
        // Skip warning flags
        if (key.includes(':warning_sent:')) continue;

        const parts = key.split(':');
        if (parts.length < 4) continue;

        const orgId = parts[1];
        const metric = parts[2];
        const periodStartStr = parts[3];

        if (
          metric !== 'jobs' &&
          metric !== 'uploads' &&
          metric !== 'api_calls' &&
          metric !== 'reports'
        ) {
          continue;
        }

        try {
          const redisVal = await redisClient.get(key);
          const count = redisVal ? parseInt(redisVal, 10) : 0;

          // Track delta using last synced value in Redis
          const syncedKey = `usage_synced:${orgId}:${metric}:${periodStartStr}`;
          const lastSyncedVal = await redisClient.get(syncedKey);
          const lastSynced = lastSyncedVal ? parseInt(lastSyncedVal, 10) : 0;

          const delta = count - lastSynced;
          if (delta > 0) {
            await query(
              `UPDATE usage_records
               SET jobs_run = jobs_run + CASE WHEN $1 = 'jobs' THEN $2 ELSE 0 END,
                   uploads_count = uploads_count + CASE WHEN $1 = 'uploads' THEN $2 ELSE 0 END,
                   api_calls = api_calls + CASE WHEN $1 = 'api_calls' THEN $2 ELSE 0 END,
                   reports_generated = reports_generated + CASE WHEN $1 = 'reports' THEN $2 ELSE 0 END
               WHERE org_id = $3 AND period_start = $4`,
              [metric, delta, orgId, new Date(periodStartStr)],
            );
            await redisClient.setex(syncedKey, 35 * 24 * 60 * 60, count.toString());
          }
        } catch (itemErr: any) {
          logger.error(
            `[UsageService.syncUsageToDatabase] Failed sync for key ${key}: ${itemErr.message}`,
          );
        }
      }
    } catch (err: any) {
      logger.error(`[UsageService.syncUsageToDatabase] Error: ${err.message}`);
    }
  }

  /**
   * Retrieves usage summary for the current active period
   */
  static async getCurrentPeriodUsage(orgId: string): Promise<UsageSummary> {
    const { periodStart, planTier } = await this.getOrCreateCurrentPeriod(orgId);
    const limits = PLAN_LIMITS[planTier.toLowerCase()] || PLAN_LIMITS.starter;

    // Fetch current counts from DB (or sync first)
    const usageRes = await query(
      `SELECT * FROM usage_records 
       WHERE org_id = $1 AND period_start = $2`,
      [orgId, periodStart],
    );

    let jobsRun = 0;
    let uploadsCount = 0;
    let apiCalls = 0;
    let reportsGenerated = 0;
    let periodEnd = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();

    if (usageRes.rowCount && usageRes.rowCount > 0) {
      const row = usageRes.rows[0];
      jobsRun = row.jobs_run;
      uploadsCount = row.uploads_count;
      apiCalls = row.api_calls;
      reportsGenerated = row.reports_generated;
      periodEnd = new Date(row.period_end).toISOString();
    }

    const pctUsed = parseFloat(((jobsRun / limits.jobs) * 100).toFixed(1));

    return {
      jobsRun,
      jobsLimit: limits.jobs,
      jobsRemaining: Math.max(0, limits.jobs - jobsRun),
      uploadsCount,
      uploadsLimit: limits.uploads,
      apiCalls,
      reportsGenerated,
      periodStart: periodStart.toISOString(),
      periodEnd,
      pctUsed,
    };
  }
}
