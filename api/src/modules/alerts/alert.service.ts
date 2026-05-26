import { query } from '../../shared/database/pool.js';
import { Alert, AlertFilters, AlertSeverity } from './alert.types.js';
import { ForbiddenError, NotFoundError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { JobAggregation } from '../jobs/job.aggregator.js';
import { socketEmitter } from '../../shared/websocket/socket.emitter.js';

export class AlertService {
  /**
   * Generates alerts for a completed detection job based on its results.
   */
  static async generateAlerts(jobId: string, orgId: string): Promise<Alert[]> {
    // 1. Fetch all detection_results for this jobId
    const resultsRes = await query(
      `SELECT * FROM detection_results WHERE job_id = $1 AND org_id = $2`,
      [jobId, orgId]
    );
    const results = resultsRes.rows;

    const createdAlerts: Alert[] = [];

    for (const res of results) {
      const score = Number(res.score);
      
      // Skip results with score < 25 (no alert needed)
      if (score < 25) {
        continue;
      }

      // Determine severity
      let severity: AlertSeverity = 'low';
      if (score >= 91) {
        severity = 'critical';
      } else if (score >= 76) {
        severity = 'high';
      } else if (score >= 51) {
        severity = 'medium';
      }

      // Generate human-readable title and summary
      let title = `Suspicious activity flagged in module: ${res.module}`;
      let summary = `Analysis flagged a confidence score of ${score}% indicating possible manipulation under the ${res.module} module.`;

      if (res.module === 'deepfake') {
        title = `Potential deepfake detected in uploaded media`;
        summary = `Analysis detected ${score}% probability of face or digital voice manipulation under face artifacts scanning.`;
      } else if (res.module === 'fake_news') {
        title = `Unreliable or manipulated news content flagged`;
        summary = `Content analysis returned a high risk probability of ${score}% matching sensationalist or biased sources.`;
      } else if (res.module === 'stolen_content') {
        title = `Potential copyright or stolen content match detected`;
        summary = `Content match engine identified an index overlap of ${score}% against known indexed source repositories.`;
      } else if (res.module === 'metadata_tampering') {
        title = `Potential metadata or ELA alteration flagged`;
        summary = `EXIF forensics and Error Level Analysis identified re-compression and software edit flags yielding a risk of ${score}%.`;
      }

      // Insert to alerts table
      const insertRes = await query(
        `INSERT INTO alerts (
          org_id, 
          result_id, 
          job_id, 
          severity, 
          title, 
          summary, 
          notification_sent, 
          notification_channels
        )
        VALUES ($1, $2, $3, $4, $5, $6, false, '{}')
        RETURNING *`,
        [orgId, res.id, jobId, severity, title, summary]
      );

      const alert = insertRes.rows[0];
      createdAlerts.push(alert);

      // Emit WebSocket alerts in real-time
      socketEmitter.emitNewAlert(orgId, alert);
      socketEmitter.emitUnreadAlertCount(null, orgId);

      logger.info(`Generated ${severity} alert for Job ${jobId} (Score: ${score})`);
    }

    return createdAlerts;
  }

  /**
   * Acknowledges an alert by its ID.
   */
  static async acknowledgeAlert(alertId: string, userId: string, orgId: string): Promise<Alert> {
    const alertRes = await query(`SELECT * FROM alerts WHERE id = $1`, [alertId]);
    const alert = alertRes.rows[0];

    if (!alert) {
      throw new NotFoundError(`Alert not found: ${alertId}`);
    }

    if (alert.org_id !== orgId) {
      throw new ForbiddenError('You do not have permission to access this alert');
    }

    const updatedRes = await query(
      `UPDATE alerts 
       SET acknowledged_by = $1, acknowledged_at = NOW(), updated_at = NOW() 
       WHERE id = $2 
       RETURNING *`,
      [userId, alertId]
    );

    // Log to audit logs
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'ALERT_ACKNOWLEDGED', 'alerts', $3)`,
      [orgId, userId, alertId]
    );

    logger.info(`Alert ${alertId} acknowledged by user ${userId}`);
    const acknowledgedAlert = updatedRes.rows[0];
    socketEmitter.emitAlertUpdate(orgId, alertId, acknowledgedAlert);
    socketEmitter.emitUnreadAlertCount(null, orgId);

    return acknowledgedAlert;
  }

  /**
   * Resolves an alert by its ID.
   */
  static async resolveAlert(alertId: string, userId: string, orgId: string): Promise<Alert> {
    const alertRes = await query(`SELECT * FROM alerts WHERE id = $1`, [alertId]);
    const alert = alertRes.rows[0];

    if (!alert) {
      throw new NotFoundError(`Alert not found: ${alertId}`);
    }

    if (alert.org_id !== orgId) {
      throw new ForbiddenError('You do not have permission to access this alert');
    }

    const updatedRes = await query(
      `UPDATE alerts 
       SET resolved_by = $1, resolved_at = NOW(), updated_at = NOW() 
       WHERE id = $2 
       RETURNING *`,
      [userId, alertId]
    );

    // Log to audit logs
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'ALERT_RESOLVED', 'alerts', $3)`,
      [orgId, userId, alertId]
    );

    logger.info(`Alert ${alertId} resolved by user ${userId}`);
    return updatedRes.rows[0];
  }

  /**
   * Retrieves alerts for an organization with paginated filtering.
   */
  static async getAlerts(
    orgId: string,
    filters: AlertFilters
  ): Promise<{ alerts: Alert[]; total: number; unreadCount: number }> {
    const { severity, acknowledged, page = 1, limit = 10 } = filters;
    const offset = (page - 1) * limit;

    let baseFilter = `WHERE a.org_id = $1`;
    const params: any[] = [orgId];

    let paramIdx = 2;
    if (severity) {
      baseFilter += ` AND a.severity = $${paramIdx}`;
      params.push(severity);
      paramIdx++;
    }

    if (acknowledged !== undefined) {
      if (acknowledged) {
        baseFilter += ` AND a.acknowledged_at IS NOT NULL`;
      } else {
        baseFilter += ` AND a.acknowledged_at IS NULL`;
      }
    }

    // Unread count is total unacknowledged alerts for this org
    const unreadRes = await query(
      `SELECT COUNT(*)::int as count FROM alerts WHERE org_id = $1 AND acknowledged_at IS NULL`,
      [orgId]
    );
    const unreadCount = unreadRes.rows[0].count;

    // Total count for filters
    const totalRes = await query(`
      SELECT COUNT(*)::int as count 
      FROM alerts a
      ${baseFilter}
    `, params);
    const total = totalRes.rows[0].count;

    // Fetch paginated results ordered by creation date desc
    const queryStr = `
      SELECT a.*,
             CASE 
               WHEN dr.id IS NOT NULL THEN json_build_object('id', dr.id, 'module', dr.module, 'score', dr.score, 'verdict', dr.verdict)
               ELSE NULL
             END as result
      FROM alerts a
      LEFT JOIN detection_results dr ON a.result_id = dr.id
      ${baseFilter} 
      ORDER BY a.created_at DESC 
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    params.push(limit, offset);

    const alertsRes = await query(queryStr, params);

    return {
      alerts: alertsRes.rows,
      total,
      unreadCount,
    };
  }

  /**
   * Generates alerts using the aggregated job results for intelligent severity mapping.
   */
  static async generateAlertsForJob(
    jobId: string,
    orgId: string,
    aggregation: JobAggregation
  ): Promise<Alert[]> {
    // No alert for 'none' risk level
    if (aggregation.riskLevel === 'none') {
      return [];
    }

    // Map risk level to alert severity
    const severityMap: Record<string, AlertSeverity> = {
      low: 'low',
      medium: 'medium',
      high: 'high',
      critical: 'critical',
    };
    const severity = severityMap[aggregation.riskLevel] || 'low';

    // Build title based on dominant threat and risk level
    const threatNames: Record<string, string> = {
      deepfake: 'Deepfake indicators',
      fake_news: 'Misinformation signals',
      stolen_content: 'Stolen content match',
      metadata_tampering: 'Metadata tampering',
    };

    let title: string;
    const dominantName = aggregation.dominantThreat
      ? threatNames[aggregation.dominantThreat] || aggregation.dominantThreat
      : null;

    const threatsAbove50 = Object.values(aggregation.moduleScores).filter((s) => s > 50).length;

    if (aggregation.riskLevel === 'critical' && threatsAbove50 > 1) {
      title = 'Critical: Multiple threats detected in analyzed content';
    } else if (aggregation.riskLevel === 'critical') {
      title = `Critical: ${dominantName || 'Severe threats'} detected`;
    } else if (aggregation.riskLevel === 'high') {
      title = `High risk: ${dominantName || 'Elevated threats'} detected`;
    } else if (aggregation.riskLevel === 'medium') {
      title = `Medium risk: ${dominantName || 'Suspicious signals'} in analyzed content`;
    } else {
      title = `Low risk: Minor indicators detected in analyzed content`;
    }

    const summaryText = aggregation.summary;

    const insertRes = await query(
      `INSERT INTO alerts (
        org_id,
        job_id,
        severity,
        title,
        summary,
        notification_sent,
        notification_channels
      )
      VALUES ($1, $2, $3, $4, $5, false, '{}')
      RETURNING *`,
      [orgId, jobId, severity, title, summaryText]
    );

    const alert = insertRes.rows[0];
    logger.info(`Generated ${severity} aggregation alert for Job ${jobId}: ${title}`);
    return [alert];
  }
}
