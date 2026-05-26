import { query } from '../../shared/database/pool.js';
import { cacheService } from '../../shared/redis/cache.service.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errorHandler.js';
import { HumanReview, SubmitReviewDTO, ReviewQueueStats, ReviewerWorkload } from './review.types.js';
import { DetectionResult, DetectionJob } from '../jobs/job.types.js';
import { aggregateResults } from '../jobs/job.aggregator.js';
import nodemailer from 'nodemailer';
import { socketEmitter } from '../../shared/websocket/socket.emitter.js';

export class ReviewService {
  /**
   * Determine if a detection result should trigger a human review task.
   */
  static shouldTriggerHumanReview(score: number, results?: DetectionResult[]): boolean {
    const min = env.HUMAN_REVIEW_SCORE_MIN;
    const max = env.HUMAN_REVIEW_SCORE_MAX;
    if (score >= min && score <= max) {
      return true;
    }
    if (results && results.length > 0) {
      const verdicts = results.map((r) => r.verdict);
      if (verdicts.includes('requires_review')) {
        return true;
      }
      const hasClean = verdicts.includes('clean');
      const hasManipulated = verdicts.includes('manipulated');
      if (hasClean && hasManipulated) {
        return true;
      }
    }
    return false;
  }

  /**
   * Create a new human review task for an ambiguous detection result.
   */
  static async createReviewTask(result: DetectionResult, job: DetectionJob): Promise<HumanReview> {
    // 1. Fetch organization plan tier to determine priority
    const orgRes = await query(`SELECT plan_tier FROM organizations WHERE id = $1`, [job.org_id]);
    const org = orgRes.rows[0];
    const planTier = org ? org.plan_tier : 'starter';

    // 2. Determine priority
    let priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal';
    if (planTier === 'enterprise') {
      priority = 'urgent';
    } else if (planTier === 'pro') {
      priority = 'high';
    } else if (result.score > 60) {
      priority = 'high';
    } else if (result.score >= 50 && result.score <= 60) {
      priority = 'normal';
    } else if (result.score < 50) {
      priority = 'low';
    }

    // 3. Calculate SLA deadline
    let slaHours = 24;
    if (priority === 'urgent') {
      slaHours = 4;
    } else if (priority === 'high') {
      slaHours = 8;
    } else if (priority === 'normal') {
      slaHours = 24;
    } else if (priority === 'low') {
      slaHours = 72;
    }

    const slaDeadline = new Date();
    slaDeadline.setHours(slaDeadline.getHours() + slaHours);

    // 4. Insert into database
    const insertRes = await query(
      `INSERT INTO human_reviews (
        result_id,
        job_id,
        org_id,
        status,
        priority,
        ai_score,
        ai_verdict,
        sla_deadline
      ) VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)
      RETURNING *`,
      [result.id, job.id, job.org_id, priority, result.score, result.verdict, slaDeadline]
    );

    const review = insertRes.rows[0];
    logger.info(`Human review task created: ${review.id} with priority: ${priority}`);

    // 5. Notify review team via email
    const emailTo = env.HUMAN_REVIEW_NOTIFICATION_EMAIL;
    if (emailTo) {
      try {
        const transporter = nodemailer.createTransport({
          host: env.SMTP_HOST || 'localhost',
          port: env.SMTP_PORT || 587,
          secure: env.SMTP_PORT === 465,
          auth: env.SMTP_USER ? {
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
          } : undefined,
        });

        await transporter.sendMail({
          from: env.SMTP_FROM || 'alerts@truthshield.ai',
          to: emailTo,
          subject: `[TruthShield] Human Review Required (Priority: ${priority.toUpperCase()})`,
          text: `A new human review task has been created.\n\nReview ID: ${review.id}\nAI Score: ${result.score}%\nAI Verdict: ${result.verdict}\nSLA Deadline: ${slaDeadline.toISOString()}\n`,
          html: `<p>A new human review task has been created.</p><p><strong>Review ID:</strong> ${review.id}</p><p><strong>AI Score:</strong> ${result.score}%</p><p><strong>AI Verdict:</strong> ${result.verdict}</p><p><strong>SLA Deadline:</strong> ${slaDeadline.toISOString()}</p>`,
        });
        logger.info(`Notification email sent to ${emailTo}`);
      } catch (err: any) {
        logger.error(`Notification email failed: ${err?.message || err}`);
      }
    }

    return review;
  }

  /**
   * Assign a review to an analyst.
   */
  static async assignReview(reviewId: string, analystUserId: string): Promise<HumanReview> {
    // 1. Validate analyst role
    const userRes = await query(`SELECT role FROM users WHERE id = $1`, [analystUserId]);
    const user = userRes.rows[0];
    if (!user || (user.role !== 'analyst' && user.role !== 'admin')) {
      throw new ForbiddenError('User is not an authorized analyst or admin');
    }

    // 2. Check workload limit
    const workloadRes = await query(
      `SELECT COUNT(*)::int as count FROM human_reviews WHERE assigned_to = $1 AND status IN ('assigned', 'in_review')`,
      [analystUserId]
    );
    if (workloadRes.rows[0].count >= 10) {
      throw new ValidationError('Analyst has reached the maximum workload limit of 10 active reviews');
    }

    // 3. Retrieve review
    const reviewRes = await query(`SELECT * FROM human_reviews WHERE id = $1`, [reviewId]);
    const review = reviewRes.rows[0];
    if (!review) {
      throw new NotFoundError(`Review not found: ${reviewId}`);
    }

    // 4. Update assignment
    const updatedRes = await query(
      `UPDATE human_reviews 
       SET assigned_to = $1, assigned_at = NOW(), status = 'assigned', updated_at = NOW() 
       WHERE id = $2 
       RETURNING *`,
      [analystUserId, reviewId]
    );
    const updatedReview = updatedRes.rows[0];

    // 5. Log audit
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'REVIEW_ASSIGNED', 'human_reviews', $3)`,
      [review.org_id, analystUserId, reviewId]
    );

    logger.info(`Review ${reviewId} assigned to analyst ${analystUserId}`);
    socketEmitter.emitReviewAssigned(analystUserId, updatedReview);
    return updatedReview;
  }

  /**
   * Start review task.
   */
  static async startReview(reviewId: string, analystUserId: string): Promise<HumanReview> {
    const reviewRes = await query(`SELECT * FROM human_reviews WHERE id = $1`, [reviewId]);
    const review = reviewRes.rows[0];
    if (!review) {
      throw new NotFoundError(`Review not found: ${reviewId}`);
    }

    if (review.assigned_to !== analystUserId) {
      throw new ForbiddenError('You are not the assigned analyst for this review task');
    }

    const updatedRes = await query(
      `UPDATE human_reviews 
       SET started_at = NOW(), status = 'in_review', updated_at = NOW() 
       WHERE id = $1 
       RETURNING *`,
      [reviewId]
    );

    return updatedRes.rows[0];
  }

  /**
   * Submit analyst verdict and complete review.
   */
  static async submitReview(reviewId: string, analystUserId: string, dto: SubmitReviewDTO): Promise<HumanReview> {
    const { reviewerVerdict, reviewerNotes, reviewerConfidence, overrideReason } = dto;

    if (!reviewerVerdict || !reviewerNotes || !reviewerConfidence) {
      throw new ValidationError('Required fields are missing: reviewerVerdict, reviewerNotes, reviewerConfidence');
    }

    const reviewRes = await query(`SELECT * FROM human_reviews WHERE id = $1`, [reviewId]);
    const review = reviewRes.rows[0];
    if (!review) {
      throw new NotFoundError(`Review not found: ${reviewId}`);
    }

    if (review.assigned_to !== analystUserId) {
      throw new ForbiddenError('You are not the assigned analyst for this review task');
    }

    const updatedRes = await query(
      `UPDATE human_reviews 
       SET reviewer_verdict = $1, 
           reviewer_notes = $2, 
           reviewer_confidence = $3, 
           override_reason = $4,
           completed_at = NOW(), 
           status = 'completed', 
           updated_at = NOW() 
       WHERE id = $5 
       RETURNING *`,
      [reviewerVerdict, reviewerNotes, reviewerConfidence, overrideReason || null, reviewId]
    );
    const completedReview = updatedRes.rows[0];

    // Recalculate and update result/aggregation
    await this.applyReviewDecision(completedReview);

    // Log audit
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'REVIEW_COMPLETED', 'human_reviews', $3)`,
      [review.org_id, analystUserId, reviewId]
    );

    // Invalidate organization cache
    await cacheService.invalidateOrgCache(review.org_id);

    logger.info(`Review ${reviewId} completed by analyst ${analystUserId}`);
    socketEmitter.emitDashboardRefresh(review.org_id);
    return completedReview;
  }

  /**
   * Apply the analyst review decision onto the detection result and job aggregation.
   */
  static async applyReviewDecision(review: HumanReview): Promise<void> {
    const verdict = review.reviewer_verdict;
    if (!verdict) return;

    // Check if human review verdict overrides AI verdict
    // valid detection_result verdicts are: 'clean', 'suspicious', 'manipulated', 'requires_review'
    if (['clean', 'suspicious', 'manipulated'].includes(verdict)) {
      // Fetch current result to see if we're actually overriding the verdict
      const resultRes = await query(`SELECT * FROM detection_results WHERE id = $1`, [review.result_id]);
      const currentResult = resultRes.rows[0];

      if (currentResult) {
        let flags = currentResult.flags || [];
        if (verdict !== review.ai_verdict && !flags.includes('human_review_override')) {
          flags = [...flags, 'human_review_override'];
        }

        await query(
          `UPDATE detection_results 
           SET verdict = $1, 
               flags = $2, 
               reviewed_by = $3, 
               reviewed_at = NOW(), 
               review_notes = $4 
           WHERE id = $5`,
          [verdict, flags, review.assigned_to, review.reviewer_notes, review.result_id]
        );
      }
    }

    // Fetch all detection results for this job to recalculate aggregation
    const resultsRes = await query(`SELECT * FROM detection_results WHERE job_id = $1`, [review.job_id]);
    const aggregation = aggregateResults(resultsRes.rows);

    // Update job aggregation fields
    await query(
      `UPDATE detection_jobs 
       SET aggregated_score = $1,
           aggregated_verdict = $2,
           aggregated_risk_level = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [aggregation.overallScore, aggregation.overallVerdict, aggregation.riskLevel, review.job_id]
    );

    // If verdict changed significantly (e.g. was clean/suspicious and is now manipulated)
    const isNewManipulated = verdict === 'manipulated';
    const wasOldClean = review.ai_verdict === 'clean' || review.ai_verdict === 'suspicious';
    if (isNewManipulated && wasOldClean) {
      await query(
        `INSERT INTO alerts (org_id, job_id, result_id, severity, title, summary, notification_sent, notification_channels)
         VALUES ($1, $2, $3, 'high', 'Human Override: Manipulated Content Detected', 'Analyst marked the result as manipulated after human review.', false, '{}')`,
        [review.org_id, review.job_id, review.result_id]
      );
    }

    // If verdict changed to clean, resolve any active alerts
    if (verdict === 'clean') {
      await query(
        `UPDATE alerts 
         SET resolved_by = $1, resolved_at = NOW(), updated_at = NOW() 
         WHERE (result_id = $2 OR job_id = $3) AND resolved_at IS NULL`,
        [review.assigned_to || '00000000-0000-0000-0000-000000000000', review.result_id, review.job_id]
      );
    }
  }

  /**
   * Escalate a review task to a senior analyst.
   */
  static async escalateReview(reviewId: string, analystUserId: string, reason: string): Promise<HumanReview> {
    const reviewRes = await query(`SELECT * FROM human_reviews WHERE id = $1`, [reviewId]);
    const review = reviewRes.rows[0];
    if (!review) {
      throw new NotFoundError(`Review not found: ${reviewId}`);
    }

    if (review.assigned_to !== analystUserId) {
      throw new ForbiddenError('You are not the assigned analyst for this review task');
    }

    // 1. Escalate the current review task
    const updatedRes = await query(
      `UPDATE human_reviews 
       SET status = 'escalated', 
           reviewer_notes = COALESCE(reviewer_notes, '') || '\nEscalation Reason: ' || $1,
           updated_at = NOW() 
       WHERE id = $2 
       RETURNING *`,
      [reason, reviewId]
    );
    const escalatedReview = updatedRes.rows[0];

    // 2. Notify senior analyst via email
    const emailTo = env.HUMAN_REVIEW_NOTIFICATION_EMAIL;
    if (emailTo) {
      try {
        const transporter = nodemailer.createTransport({
          host: env.SMTP_HOST || 'localhost',
          port: env.SMTP_PORT || 587,
          secure: env.SMTP_PORT === 465,
          auth: env.SMTP_USER ? {
            user: env.SMTP_USER,
            pass: env.SMTP_PASS,
          } : undefined,
        });

        await transporter.sendMail({
          from: env.SMTP_FROM || 'alerts@truthshield.ai',
          to: emailTo,
          subject: `[TruthShield] URGENT Escalated Review Task #${reviewId}`,
          text: `Analyst ${analystUserId} has escalated review task #${reviewId}.\n\nReason: ${reason}`,
          html: `<p>Analyst <strong>${analystUserId}</strong> has escalated review task <strong>#${reviewId}</strong>.</p><p><strong>Reason:</strong> ${reason}</p>`,
        });
      } catch (err: any) {
        logger.error(`Escalation email dispatch failed: ${err?.message || err}`);
      }
    }

    // 3. Create new review task with priority 'urgent' and 4 hour SLA
    const slaDeadline = new Date();
    slaDeadline.setHours(slaDeadline.getHours() + 4);

    await query(
      `INSERT INTO human_reviews (
        result_id,
        job_id,
        org_id,
        status,
        priority,
        ai_score,
        ai_verdict,
        sla_deadline
      ) VALUES ($1, $2, $3, 'pending', 'urgent', $4, $5, $6)`,
      [review.result_id, review.job_id, review.org_id, review.ai_score, review.ai_verdict, slaDeadline]
    );

    return escalatedReview;
  }

  /**
   * Auto resolve all active human review tasks past their SLA deadline.
   */
  static async autoResolveExpiredReviews(): Promise<number> {
    const expiredRes = await query(
      `SELECT * FROM human_reviews 
       WHERE sla_deadline < NOW() 
         AND status NOT IN ('completed', 'auto_resolved', 'escalated')`
    );
    const expiredReviews = expiredRes.rows;

    for (const review of expiredReviews) {
      await query(
        `UPDATE human_reviews 
         SET status = 'auto_resolved', 
             reviewer_verdict = ai_verdict, 
             override_reason = 'auto_resolved_sla_breach', 
             completed_at = NOW(), 
             updated_at = NOW() 
         WHERE id = $1`,
        [review.id]
      );

      // Create SLA breach alert
      await query(
        `INSERT INTO alerts (org_id, job_id, result_id, severity, title, summary, notification_sent, notification_channels)
         VALUES ($1, $2, $3, 'high', 'SLA Breach: Auto-Resolved Review', 'A human review task breached its SLA deadline and was automatically resolved with the original AI verdict.', false, '{}')`,
        [review.org_id, review.job_id, review.result_id]
      );
    }

    return expiredReviews.length;
  }

  /**
   * Retrieve human review queue with paginated filtering.
   */
  static async getReviewQueue(
    orgId: string,
    filters: {
      status?: string;
      priority?: string;
      assignedTo?: string;
      page: number;
      limit: number;
    }
  ): Promise<{ reviews: HumanReview[]; total: number }> {
    const { status, priority, assignedTo, page = 1, limit = 10 } = filters;
    const offset = (page - 1) * limit;

    let baseFilter = `WHERE hr.org_id = $1`;
    const params: any[] = [orgId];
    let paramIdx = 2;

    if (status) {
      baseFilter += ` AND hr.status = $${paramIdx}`;
      params.push(status);
      paramIdx++;
    }

    if (priority) {
      baseFilter += ` AND hr.priority = $${paramIdx}`;
      params.push(priority);
      paramIdx++;
    }

    if (assignedTo) {
      baseFilter += ` AND hr.assigned_to = $${paramIdx}`;
      params.push(assignedTo);
      paramIdx++;
    }

    const totalRes = await query(`
      SELECT COUNT(*)::int as count 
      FROM human_reviews hr
      ${baseFilter}
    `, params);
    const total = totalRes.rows[0].count;

    const queryStr = `
      SELECT hr.*, 
             json_build_object('id', dj.id, 'content_type', dj.content_type, 'status', dj.status) as job,
             json_build_object('id', dr.id, 'module', dr.module, 'score', dr.score, 'verdict', dr.verdict) as result
      FROM human_reviews hr
      JOIN detection_jobs dj ON hr.job_id = dj.id
      JOIN detection_results dr ON hr.result_id = dr.id
      ${baseFilter}
      ORDER BY 
        CASE hr.priority
          WHEN 'urgent' THEN 1
          WHEN 'high' THEN 2
          WHEN 'normal' THEN 3
          WHEN 'low' THEN 4
          ELSE 5
        END ASC, 
        hr.sla_deadline ASC 
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    params.push(limit, offset);

    const reviewsRes = await query(queryStr, params);

    return {
      reviews: reviewsRes.rows,
      total,
    };
  }

  /**
   * Retrieve reviews assigned to a particular analyst.
   */
  static async getMyReviews(analystUserId: string, page: number, limit: number): Promise<HumanReview[]> {
    const offset = (page - 1) * limit;

    const reviewsRes = await query(
      `SELECT hr.*, 
              json_build_object('id', dj.id, 'content_type', dj.content_type, 'status', dj.status) as job,
              json_build_object('id', dr.id, 'module', dr.module, 'score', dr.score, 'verdict', dr.verdict) as result
       FROM human_reviews hr
       JOIN detection_jobs dj ON hr.job_id = dj.id
       JOIN detection_results dr ON hr.result_id = dr.id
       WHERE hr.assigned_to = $1
       ORDER BY 
         CASE hr.priority
           WHEN 'urgent' THEN 1
           WHEN 'high' THEN 2
           WHEN 'normal' THEN 3
           WHEN 'low' THEN 4
           ELSE 5
         END ASC, 
         hr.sla_deadline ASC
       LIMIT $2 OFFSET $3`,
      [analystUserId, limit, offset]
    );

    return reviewsRes.rows;
  }

  /**
   * Retrieve statistics about the human review queue.
   */
  static async getReviewStats(): Promise<ReviewQueueStats> {
    const pendingRes = await query(`SELECT COUNT(*)::int as count FROM human_reviews WHERE status = 'pending'`);
    const assignedRes = await query(`SELECT COUNT(*)::int as count FROM human_reviews WHERE status = 'assigned'`);
    const inReviewRes = await query(`SELECT COUNT(*)::int as count FROM human_reviews WHERE status = 'in_review'`);

    const overdueRes = await query(
      `SELECT COUNT(*)::int as count FROM human_reviews WHERE sla_deadline < NOW() AND status NOT IN ('completed', 'auto_resolved', 'escalated')`
    );

    const avgRes = await query(
      `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - created_at))/3600), 0)::float as avg_hours 
       FROM human_reviews 
       WHERE status = 'completed' AND completed_at IS NOT NULL`
    );

    const analystsRes = await query(
      `SELECT u.id as reviewer_id, u.email as reviewer_email, count(hr.id)::int as active_count
       FROM users u
       LEFT JOIN human_reviews hr ON u.id = hr.assigned_to AND hr.status IN ('assigned', 'in_review')
       WHERE u.role IN ('analyst', 'admin')
       GROUP BY u.id, u.email`
    );

    const workloads: ReviewerWorkload[] = analystsRes.rows.map((row: any) => ({
      reviewerId: row.reviewer_id,
      reviewerEmail: row.reviewer_email,
      activeCount: row.active_count,
    }));

    return {
      pending: pendingRes.rows[0].count,
      assigned: assignedRes.rows[0].count,
      inReview: inReviewRes.rows[0].count,
      overdueCount: overdueRes.rows[0].count,
      avgResolutionHours: Math.round(avgRes.rows[0].avg_hours * 10) / 10,
      reviewerWorkloads: workloads,
    };
  }

  /**
   * Fetch a single review details with contextual job and result data.
   */
  static async getReviewById(reviewId: string): Promise<any> {
    const reviewRes = await query(
      `SELECT hr.*, 
              json_build_object('id', dj.id, 'content_type', dj.content_type, 'status', dj.status, 'org_id', dj.org_id) as job,
              json_build_object('id', dr.id, 'module', dr.module, 'score', dr.score, 'verdict', dr.verdict) as result
       FROM human_reviews hr
       JOIN detection_jobs dj ON hr.job_id = dj.id
       JOIN detection_results dr ON hr.result_id = dr.id
       WHERE hr.id = $1`,
      [reviewId]
    );

    const review = reviewRes.rows[0];
    if (!review) {
      throw new NotFoundError(`Review not found: ${reviewId}`);
    }

    return review;
  }
}
