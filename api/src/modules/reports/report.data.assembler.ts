import { query } from '../../shared/database/pool.js';
import { ReportRequest, ReportData, JobWithFullResults, DMCADraft } from './report.types.js';
import { format, eachDayOfInterval } from 'date-fns';
import { TrendDataPoint, ModuleBreakdown } from '../dashboard/dashboard.types.js';

export class ReportDataAssembler {
  /**
   * Orchestrates parallel retrieval of database structures required for reports.
   */
  async assembleReportData(request: ReportRequest): Promise<ReportData> {
    const { orgId, requestedBy, dateRange, jobIds, includeModules } = request;
    const start = new Date(dateRange.startDate);
    const end = new Date(dateRange.endDate);

    // 1. Fetch organization profile and requested by user details
    const [orgRes, userRes] = await Promise.all([
      query('SELECT * FROM organizations WHERE id = $1', [orgId]),
      query('SELECT * FROM users WHERE id = $1', [requestedBy]),
    ]);

    const org = orgRes.rows[0];
    const user = userRes.rows[0];

    if (!org) {
      throw new Error('Organization not found');
    }
    if (!user) {
      throw new Error('User not found');
    }

    // 2. Build parameterized queries for jobs and alert counts
    let jobsQuery = `
      SELECT 
        j.id as job_id, 
        j.content_type, 
        j.aggregated_score as overall_score, 
        j.aggregated_verdict as verdict, 
        j.aggregated_risk_level as risk_level, 
        j.completed_at as detected_at, 
        j.s3_key,
        a.id as alert_id, 
        a.severity as alert_severity, 
        hr.id as review_id
      FROM detection_jobs j
      LEFT JOIN alerts a ON a.job_id = j.id
      LEFT JOIN human_reviews hr ON hr.job_id = j.id AND hr.status NOT IN ('completed', 'auto_resolved')
      WHERE j.org_id = $1 
        AND j.status = 'completed'
        AND j.completed_at >= $2 
        AND j.completed_at <= $3
    `;
    const jobsParams: any[] = [orgId, start, end];

    if (jobIds && jobIds.length > 0) {
      jobsParams.push(jobIds);
      jobsQuery += ` AND j.id = ANY($${jobsParams.length})`;
    }

    // Parallel aggregates
    const [jobsRes, alertsRes, reviewsRes, trendsRes, modulesRes] = await Promise.all([
      query(jobsQuery, jobsParams),
      query(
        `SELECT COUNT(*)::int as count 
         FROM alerts 
         WHERE org_id = $1 AND severity = 'critical' AND acknowledged_at IS NULL AND created_at >= $2 AND created_at <= $3`,
        [orgId, start, end],
      ),
      query(
        `SELECT COUNT(*)::int as count 
         FROM human_reviews 
         WHERE org_id = $1 AND status IN ('pending', 'assigned', 'in_review') AND created_at >= $2 AND created_at <= $3`,
        [orgId, start, end],
      ),
      query(
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
           AND j.created_at >= $2
           AND j.created_at <= $3
           AND j.status = 'completed'
         GROUP BY DATE_TRUNC('day', j.created_at)
         ORDER BY date ASC`,
        [orgId, start, end],
      ),
      query(
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
           AND created_at >= $2
           AND created_at <= $3
         GROUP BY module`,
        [orgId, start, end],
      ),
    ]);

    const jobsList = jobsRes.rows;
    const criticalAlerts = alertsRes.rows[0]?.count || 0;
    const pendingReviews = reviewsRes.rows[0]?.count || 0;

    // 3. Fetch module detection results in parallel for the retrieved jobs
    let fullJobs: JobWithFullResults[] = [];
    const dmcaDrafts: DMCADraft[] = [];

    if (jobsList.length > 0) {
      const retrievedJobIds = jobsList.map((j) => j.job_id);
      let resultsQuery = `
        SELECT id, job_id, module, score, verdict, confidence, result_data
        FROM detection_results
        WHERE org_id = $1 AND job_id = ANY($2)
      `;
      const resultsParams: any[] = [orgId, retrievedJobIds];

      if (includeModules && includeModules.length > 0) {
        resultsParams.push(includeModules);
        resultsQuery += ` AND module = ANY($${resultsParams.length})`;
      }

      const resultsRes = await query(resultsQuery, resultsParams);
      const resultsMap = resultsRes.rows.reduce(
        (acc, row) => {
          if (!acc[row.job_id]) acc[row.job_id] = [];
          acc[row.job_id].push(row);
          return acc;
        },
        {} as Record<string, any[]>,
      );

      fullJobs = jobsList.map((j) => {
        const modRes = resultsMap[j.job_id] || [];
        return {
          job_id: j.job_id,
          content_type: j.content_type,
          overall_score: j.overall_score ? Math.round(Number(j.overall_score)) : 0,
          verdict: j.verdict || 'clean',
          risk_level: j.risk_level || 'none',
          detected_at: j.detected_at ? new Date(j.detected_at).toISOString() : '',
          s3_key: j.s3_key,
          alert_id: j.alert_id,
          alert_severity: j.alert_severity,
          review_id: j.review_id,
          module_results: modRes.map((mr: any) => ({
            module: mr.module,
            score: mr.score ? Math.round(Number(mr.score)) : 0,
            verdict: mr.verdict || 'clean',
          })),
        };
      });

      // Extract DMCA drafts
      resultsRes.rows.forEach((row) => {
        if (row.module === 'stolen_content' && row.result_data) {
          try {
            const data =
              typeof row.result_data === 'string' ? JSON.parse(row.result_data) : row.result_data;
            if (data.dmcaDraft) {
              dmcaDrafts.push({
                jobId: row.job_id,
                infringingUrl: data.dmcaDraft.infringingUrl || '',
                matchType: data.dmcaDraft.matchSimilarity >= 95 ? 'exact' : 'near_duplicate',
                similarityScore: data.dmcaDraft.matchSimilarity || 0,
                originalAssetDescription:
                  data.dmcaDraft.originalAssetDescription ||
                  'Proprietary digital media asset registered on TruthShield',
                dmcaNoticeText: data.dmcaDraft.dmcaNoticeText || '',
              });
            }
          } catch {
            // Gracefully ignore parsing errors
          }
        }
      });
    }

    // 4. Interpolate trends dates
    const trendMap: Record<string, TrendDataPoint> = {};
    for (const row of trendsRes.rows) {
      if (!row.date) continue;
      const dateStr = format(new Date(row.date), 'yyyy-MM-dd');
      trendMap[dateStr] = {
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

    const intervalDays = eachDayOfInterval({ start, end });
    const trends: TrendDataPoint[] = intervalDays.map((d) => {
      const dateStr = format(d, 'yyyy-MM-dd');
      if (trendMap[dateStr]) return trendMap[dateStr];
      return {
        date: dateStr,
        jobsRun: 0,
        threatsFound: 0,
        avgScore: 0,
        byModule: { deepfake: 0, fake_news: 0, stolen_content: 0, metadata_tampering: 0 },
      };
    });

    // 5. Parse module breakdown
    const defaultModules = ['deepfake', 'fake_news', 'stolen_content', 'metadata_tampering'];
    const breakdownMap: Record<string, ModuleBreakdown> = {};

    for (const row of modulesRes.rows) {
      const mod = row.module;
      if (!mod) continue;
      breakdownMap[mod] = {
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

    const moduleBreakdown: ModuleBreakdown[] = defaultModules.map((mod) => {
      if (breakdownMap[mod]) return breakdownMap[mod];
      return {
        module: mod,
        totalRuns: 0,
        threatsFound: 0,
        avgScore: 0,
        verdictDistribution: { clean: 0, suspicious: 0, requires_review: 0, manipulated: 0 },
      };
    });

    // 6. Calculate summary metrics
    const totalJobs = fullJobs.length;
    const threatsDetected = fullJobs.filter((j) => j.overall_score > 50).length;
    const totalScore = fullJobs.reduce((sum, j) => sum + j.overall_score, 0);
    const avgScore = totalJobs > 0 ? Math.round(totalScore / totalJobs) : 0;
    const cleanJobs = fullJobs.filter((j) => j.verdict === 'clean').length;
    const cleanPct = totalJobs > 0 ? Math.round((cleanJobs / totalJobs) * 100) : 100;

    const reportId = crypto.randomUUID();

    return {
      org,
      generatedAt: new Date().toISOString(),
      generatedBy: user,
      dateRange,
      summary: {
        totalJobs,
        threatsDetected,
        criticalAlerts,
        avgScore,
        cleanPct,
        pendingReviews,
      },
      jobs: fullJobs,
      trends,
      moduleBreakdown,
      dmcaDrafts,
      reportId,
    };
  }
}
