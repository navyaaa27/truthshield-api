import { query } from '../../shared/database/pool.js';
import { cacheService } from '../../shared/redis/cache.service.js';
import { CacheKeys } from '../../shared/redis/cache.keys.js';
import { env } from '../../config/env.js';
import { subDays, format, eachDayOfInterval } from 'date-fns';
import { S3Service } from '../../shared/storage/s3.service.js';
import {
  DashboardOverview,
  ThreatFeedItem,
  TrendDataPoint,
  ModuleBreakdown,
} from './dashboard.types.js';

export class DashboardService {
  /**
   * Helper to calculate percentage trend capped at +/-200%.
   */
  private static calculateTrend(thisPeriod: number, prevPeriod: number): number {
    if (prevPeriod === 0) {
      return thisPeriod > 0 ? 200 : 0;
    }
    const percent = ((thisPeriod - prevPeriod) / prevPeriod) * 100;
    return Math.max(-200, Math.min(200, Math.round(percent)));
  }

  /**
   * Retrieves high-level executive dashboard statistics for a given organization.
   */
  static async getOverview(orgId: string): Promise<DashboardOverview> {
    const cacheKey = CacheKeys.dashboardOverview(orgId);
    const ttl = env.DASHBOARD_CACHE_TTL || 30;

    return cacheService.getOrSet(cacheKey, ttl, async () => {
      const days = env.DASHBOARD_STATS_WINDOW_DAYS || 30;

      // Run database queries in parallel
      const [
        orgRes,
        statsRes,
        prevStatsRes,
        pendingReviewsRes,
        criticalAlertsRes,
        quotaRes,
      ] = await Promise.all([
        // Query 1: Org + member count
        query(
          `SELECT o.*, COUNT(u.id)::int as member_count
           FROM organizations o
           LEFT JOIN users u ON u.org_id = o.id AND u.is_active = true
           WHERE o.id = $1
           GROUP BY o.id`,
          [orgId]
        ),
        // Query 2: Current period job statistics
        query(
          `SELECT 
             COUNT(*)::int as total,
             COUNT(*) FILTER (WHERE completed_at > NOW() - ($2 * INTERVAL '1 day'))::int as this_period,
             COUNT(*) FILTER (WHERE completed_at > NOW() - ($2 * INTERVAL '1 day') AND aggregated_score > 50)::int as threats_detected,
             ROUND(COALESCE(AVG(aggregated_score) FILTER (WHERE completed_at > NOW() - ($2 * INTERVAL '1 day')), 0)::numeric, 1)::float as avg_score,
             ROUND(
               COALESCE(
                 COUNT(*) FILTER (WHERE completed_at > NOW() - ($2 * INTERVAL '1 day') AND aggregated_verdict = 'clean')::numeric / 
                 NULLIF(COUNT(*) FILTER (WHERE completed_at > NOW() - ($2 * INTERVAL '1 day')), 0) * 100, 
                 100
               )::numeric, 
               1
             )::float as clean_pct
           FROM detection_jobs
           WHERE org_id = $1 AND status = 'completed'`,
          [orgId, days]
        ),
        // Query 3: Previous period for trend calculation
        query(
          `SELECT 
             COUNT(*) FILTER (
               WHERE completed_at > NOW() - ($2 * 2 * INTERVAL '1 day')
                 AND completed_at <= NOW() - ($2 * INTERVAL '1 day')
                 AND aggregated_score > 50
             )::int as prev_threats
           FROM detection_jobs
           WHERE org_id = $1 AND status = 'completed'`,
          [orgId, days]
        ),
        // Query 4: Pending reviews count
        query(
          `SELECT COUNT(*)::int as pending_count 
           FROM human_reviews
           WHERE org_id = $1 AND status IN ('pending', 'assigned', 'in_review')`,
          [orgId]
        ),
        // Query 5: Critical unread alerts count
        query(
          `SELECT COUNT(*)::int as critical_count 
           FROM alerts
           WHERE org_id = $1 AND severity = 'critical' AND acknowledged_at IS NULL`,
          [orgId]
        ),
        // Query 6: Quota usage this month
        query(
          `SELECT 
             COUNT(*)::int as jobs_used,
             COUNT(*) FILTER (WHERE s3_key IS NOT NULL)::int as uploads_used
           FROM detection_jobs
           WHERE org_id = $1 AND created_at > date_trunc('month', NOW())`,
          [orgId]
        ),
      ]);

      const org = orgRes.rows[0];
      if (!org) {
        throw new Error('Organization not found');
      }

      const stats = statsRes.rows[0] || { total: 0, this_period: 0, threats_detected: 0, avg_score: 0, clean_pct: 100 };
      const prevStats = prevStatsRes.rows[0] || { prev_threats: 0 };
      const pendingReviews = pendingReviewsRes.rows[0]?.pending_count || 0;
      const criticalAlerts = criticalAlertsRes.rows[0]?.critical_count || 0;
      const quota = quotaRes.rows[0] || { jobs_used: 0, uploads_used: 0 };

      // Calculate quota limits from plan tier
      const tier = (org.plan_tier || 'starter').toLowerCase();
      let jobsLimit = 1500;
      let uploadsLimit = 1500;

      if (tier === 'growth') {
        jobsLimit = 15000;
        uploadsLimit = 15000;
      } else if (tier === 'pro' || tier === 'enterprise') {
        jobsLimit = -1; // Unlimited
        uploadsLimit = -1; // Unlimited
      }

      // Threats Trend
      const threatsTrend = this.calculateTrend(stats.threats_detected || 0, prevStats.prev_threats || 0);

      // Quota reset date (1st of next month)
      const nextMonth = new Date();
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      nextMonth.setDate(1);
      nextMonth.setHours(0, 0, 0, 0);

      return {
        org: {
          id: org.id,
          name: org.name,
          planTier: org.plan_tier,
          memberCount: org.member_count || 0,
        },
        stats: {
          totalJobsAllTime: stats.total || 0,
          jobsThisPeriod: stats.this_period || 0,
          threatsDetected: stats.threats_detected || 0,
          threatsTrend,
          avgDetectionScore: stats.avg_score || 0,
          cleanContentPct: stats.clean_pct || 100,
          reviewsPending: pendingReviews,
          criticalAlerts,
        },
        quotaUsage: {
          jobsUsed: quota.jobs_used || 0,
          jobsLimit,
          uploadsUsed: quota.uploads_used || 0,
          uploadsLimit,
          resetAt: nextMonth.toISOString(),
        },
      };
    });
  }

  /**
   * Retrieves a paginated threat feed with advanced dynamic filtering.
   */
  static async getThreatFeed(
    orgId: string,
    filters: {
      riskLevel?: string;
      module?: string;
      startDate?: string;
      endDate?: string;
      page: number;
      limit: number;
    }
  ): Promise<{ items: ThreatFeedItem[]; total: number }> {
    const cacheKey = CacheKeys.dashboardFeed(orgId, filters as any);
    const ttl = env.DASHBOARD_CACHE_TTL || 30;

    return cacheService.getOrSet(cacheKey, ttl, async () => {
      const page = Math.max(1, filters.page || 1);
      const limit = Math.max(1, Math.min(100, filters.limit || 20));
      const offset = (page - 1) * limit;

      // 1. Get Total Count with identical filters
      const countValues: any[] = [orgId];
      let countQueryText = `
        SELECT COUNT(DISTINCT j.id)::int as total
        FROM detection_jobs j
        LEFT JOIN detection_results dr ON dr.job_id = j.id
        WHERE j.org_id = $1 AND j.status = 'completed'
      `;

      if (filters.riskLevel) {
        countValues.push(filters.riskLevel);
        countQueryText += ` AND j.aggregated_risk_level = $${countValues.length}`;
      }
      if (filters.module) {
        countValues.push(filters.module);
        countQueryText += ` AND EXISTS (
          SELECT 1 FROM detection_results dr2
          WHERE dr2.job_id = j.id AND dr2.module = $${countValues.length}
        )`;
      }
      if (filters.startDate) {
        countValues.push(new Date(filters.startDate));
        countQueryText += ` AND j.completed_at >= $${countValues.length}`;
      }
      if (filters.endDate) {
        countValues.push(new Date(filters.endDate));
        countQueryText += ` AND j.completed_at <= $${countValues.length}`;
      }

      const countRes = await query(countQueryText, countValues);
      const total = countRes.rows[0]?.total || 0;

      if (total === 0) {
        return { items: [], total: 0 };
      }

      // 2. Fetch paginated records
      const values: any[] = [orgId];
      let queryText = `
        SELECT 
          j.id as job_id,
          j.content_type,
          j.aggregated_score as overall_score,
          j.aggregated_verdict as verdict,
          j.aggregated_risk_level as risk_level,
          j.completed_at as detected_at,
          j.source_metadata,
          j.s3_key,
          a.id as alert_id,
          a.severity as alert_severity,
          hr.id as review_id,
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'module', dr.module,
              'score', dr.score,
              'verdict', dr.verdict
            ) ORDER BY dr.score DESC
          ) FILTER (WHERE dr.id IS NOT NULL) as module_results
        FROM detection_jobs j
        LEFT JOIN detection_results dr ON dr.job_id = j.id
        LEFT JOIN alerts a ON a.job_id = j.id
        LEFT JOIN human_reviews hr ON hr.job_id = j.id AND hr.status NOT IN ('completed', 'auto_resolved')
        WHERE j.org_id = $1 AND j.status = 'completed'
      `;

      if (filters.riskLevel) {
        values.push(filters.riskLevel);
        queryText += ` AND j.aggregated_risk_level = $${values.length}`;
      }
      if (filters.module) {
        values.push(filters.module);
        queryText += ` AND EXISTS (
          SELECT 1 FROM detection_results dr3
          WHERE dr3.job_id = j.id AND dr3.module = $${values.length}
        )`;
      }
      if (filters.startDate) {
        values.push(new Date(filters.startDate));
        queryText += ` AND j.completed_at >= $${values.length}`;
      }
      if (filters.endDate) {
        values.push(new Date(filters.endDate));
        queryText += ` AND j.completed_at <= $${values.length}`;
      }

      queryText += `
        GROUP BY j.id, a.id, a.severity, hr.id
        ORDER BY j.completed_at DESC
      `;

      values.push(limit);
      queryText += ` LIMIT $${values.length}`;

      values.push(offset);
      queryText += ` OFFSET $${values.length}`;

      const res = await query(queryText, values);

      const items: ThreatFeedItem[] = await Promise.all(
        res.rows.map(async (row) => {
          const modResults = row.module_results || [];
          
          // Determine dominant threat (highest scoring module if score >= 16)
          let dominantThreat: string | null = null;
          if (modResults.length > 0 && modResults[0].score >= 16) {
            dominantThreat = modResults[0].module;
          }

          // Generate Presigned Thumbnail Url if S3 Key is present
          let thumbnailUrl: string | null = null;
          if (row.s3_key) {
            try {
              thumbnailUrl = await S3Service.getPresignedDownloadUrl(`${row.s3_key}-thumb`, undefined, 300);
            } catch {
              thumbnailUrl = null;
            }
          }

          return {
            jobId: row.job_id,
            detectedAt: row.detected_at ? new Date(row.detected_at).toISOString() : '',
            contentType: row.content_type,
            riskLevel: row.risk_level || 'none',
            dominantThreat,
            overallScore: row.overall_score ? Math.round(Number(row.overall_score)) : 0,
            verdict: row.verdict || 'clean',
            moduleResults: modResults.map((mr: any) => ({
              module: mr.module,
              score: mr.score ? Math.round(Number(mr.score)) : 0,
              verdict: mr.verdict || 'clean',
            })),
            alertId: row.alert_id,
            alertSeverity: row.alert_severity,
            requiresReview: !!row.review_id,
            thumbnailUrl,
          };
        })
      );

      return { items, total };
    });
  }

  /**
   * Retrieves chronological trend data points for organizational telemetry.
   */
  static async getTrendData(orgId: string, days: number): Promise<TrendDataPoint[]> {
    const cacheKey = CacheKeys.dashboardTrends(orgId, days);
    const ttl = 300; // 5 minutes

    return cacheService.getOrSet(cacheKey, ttl, async () => {
      const res = await query(
        `SELECT 
           DATE_TRUNC('day', j.created_at) as date,
           COUNT(DISTINCT j.id)::int as jobs_run,
           COUNT(DISTINCT j.id) FILTER (WHERE j.aggregated_score > 50)::int as threats_found,
           ROUND(AVG(j.aggregated_score)::numeric, 1)::float as avg_score,
           COUNT(DISTINCT dr.id) FILTER (WHERE dr.module = 'deepfake' AND dr.score > 50)::int as deepfake_threats,
           COUNT(DISTINCT dr.id) FILTER (WHERE dr.module = 'fake_news' AND dr.score > 50)::int as fake_news_threats,
           COUNT(DISTINCT dr.id) FILTER (WHERE dr.module = 'stolen_content' AND dr.score > 50)::int as stolen_content_threats,
           COUNT(DISTINCT dr.id) FILTER (WHERE dr.module = 'metadata_tampering' AND dr.score > 50)::int as metadata_threats
         FROM detection_jobs j
         LEFT JOIN detection_results dr ON dr.job_id = j.id
         WHERE j.org_id = $1
           AND j.created_at > NOW() - ($2 * INTERVAL '1 day')
           AND j.status = 'completed'
         GROUP BY DATE_TRUNC('day', j.created_at)
         ORDER BY date ASC`,
        [orgId, days]
      );

      const map: Record<string, TrendDataPoint> = {};
      for (const row of res.rows) {
        if (!row.date) continue;
        const dateStr = format(new Date(row.date), 'yyyy-MM-dd');
        map[dateStr] = {
          date: dateStr,
          jobsRun: row.jobs_run || 0,
          threatsFound: row.threats_found || 0,
          avgScore: row.avg_score || 0,
          byModule: {
            deepfake: row.deepfake_threats || 0,
            fake_news: row.fake_news_threats || 0,
            stolen_content: row.stolen_content_threats || 0,
            metadata_tampering: row.metadata_threats || 0,
          },
        };
      }

      // Generate complete list of days filling missing dates with zeros
      const end = new Date();
      const start = subDays(end, days - 1);
      const allDays = eachDayOfInterval({ start, end });

      return allDays.map((d) => {
        const dateStr = format(d, 'yyyy-MM-dd');
        if (map[dateStr]) {
          return map[dateStr];
        }
        return {
          date: dateStr,
          jobsRun: 0,
          threatsFound: 0,
          avgScore: 0,
          byModule: {
            deepfake: 0,
            fake_news: 0,
            stolen_content: 0,
            metadata_tampering: 0,
          },
        };
      });
    });
  }

  /**
   * Retrieves total execution and threat distributions across all core analytical modules.
   */
  static async getModuleBreakdown(orgId: string, days: number): Promise<ModuleBreakdown[]> {
    const cacheKey = CacheKeys.dashboardModules(orgId, days);
    const ttl = 300; // 5 minutes

    return cacheService.getOrSet(cacheKey, ttl, async () => {
      const res = await query(
        `SELECT 
           module,
           COUNT(*)::int as total_runs,
           COUNT(*) FILTER (WHERE score > 50)::int as threats,
           ROUND(AVG(score)::numeric, 1)::float as avg_score,
           COUNT(*) FILTER (WHERE verdict = 'clean')::int as clean_count,
           COUNT(*) FILTER (WHERE verdict = 'suspicious')::int as suspicious_count,
           COUNT(*) FILTER (WHERE verdict = 'requires_review')::int as review_count,
           COUNT(*) FILTER (WHERE verdict = 'manipulated')::int as manipulated_count
         FROM detection_results
         WHERE org_id = $1
           AND created_at > NOW() - ($2 * INTERVAL '1 day')
         GROUP BY module`,
        [orgId, days]
      );

      const defaultModules = ['deepfake', 'fake_news', 'stolen_content', 'metadata_tampering'];
      const map: Record<string, ModuleBreakdown> = {};

      for (const row of res.rows) {
        const mod = row.module;
        if (!mod) continue;
        map[mod] = {
          module: mod,
          totalRuns: row.total_runs || 0,
          threatsFound: row.threats || 0,
          avgScore: row.avg_score || 0,
          verdictDistribution: {
            clean: row.clean_count || 0,
            suspicious: row.suspicious_count || 0,
            requires_review: row.review_count || 0,
            manipulated: row.manipulated_count || 0,
          },
        };
      }

      return defaultModules.map((mod) => {
        if (map[mod]) return map[mod];
        return {
          module: mod,
          totalRuns: 0,
          threatsFound: 0,
          avgScore: 0,
          verdictDistribution: {
            clean: 0,
            suspicious: 0,
            requires_review: 0,
            manipulated: 0,
          },
        };
      });
    });
  }
}
