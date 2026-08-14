import { query } from '../../shared/database/pool.js';
import { cacheService } from '../../shared/redis/cache.service.js';
import { ValidationError, NotFoundError } from '../../middleware/errorHandler.js';
import { DetectionJob, CreateJobDTO, JobWithResults, DetectionResult } from './job.types.js';

/**
 * Validates module alignment compatibility for content types.
 */
function validateJobModules(contentType: string, modules: string[]): void {
  for (const mod of modules) {
    if (mod === 'deepfake' && contentType !== 'video' && contentType !== 'image') {
      throw new ValidationError(
        `Module 'deepfake' is only compatible with 'video' or 'image' content types`,
      );
    }
    if (mod === 'fake_news' && contentType !== 'article' && contentType !== 'url') {
      throw new ValidationError(
        `Module 'fake_news' is only compatible with 'article' or 'url' content types`,
      );
    }
  }
}

export class JobModel {
  /**
   * Creates a new detection job in the database.
   */
  static async createJob(orgId: string, userId: string, dto: CreateJobDTO): Promise<DetectionJob> {
    const { contentType, detectionModules, sourceUrl, priority } = dto;

    // 1. Validation: Verify non-empty modules list
    if (!detectionModules || detectionModules.length === 0) {
      throw new ValidationError('At least one detection module must be specified');
    }

    // 2. Validation: Verify sourceUrl is provided for url content type
    if ((contentType === 'url' || contentType === 'article') && !sourceUrl) {
      throw new ValidationError(`sourceUrl is required for content type '${contentType}'`);
    }

    // 3. Validation: Verify module-content compatibility
    validateJobModules(contentType, detectionModules);

    // 4. Default priority mapping
    const finalPriority = priority !== undefined ? priority : 5;
    if (finalPriority < 1 || finalPriority > 10) {
      throw new ValidationError('Job priority must be between 1 and 10');
    }

    const res = await query(
      `INSERT INTO detection_jobs (
        org_id, 
        created_by, 
        content_type, 
        detection_modules, 
        status, 
        priority, 
        source_url
      ) 
      VALUES ($1, $2, $3, $4, 'pending', $5, $6) 
      RETURNING *`,
      [orgId, userId, contentType, detectionModules, finalPriority, sourceUrl || null],
    );

    return res.rows[0];
  }

  /**
   * Fetches a single job scoped by organization ID.
   */
  static async getJobById(jobId: string, orgId: string): Promise<DetectionJob | null> {
    const res = await query(`SELECT * FROM detection_jobs WHERE id = $1 AND org_id = $2`, [
      jobId,
      orgId,
    ]);
    return res.rows[0] || null;
  }

  /**
   * Queries and paginates jobs matching organization scope and dynamic filters.
   */
  static async getJobsByOrg(
    orgId: string,
    filters: {
      status?: string;
      contentType?: string;
      page: number;
      limit: number;
    },
  ): Promise<{ jobs: DetectionJob[]; total: number; page: number }> {
    const page = Math.max(1, filters.page || 1);
    const limit = Math.min(Math.max(1, filters.limit || 10), 100);
    const offset = (page - 1) * limit;

    let queryText = `
      SELECT j.*, 
        latest_result.score as latest_score,
        latest_result.verdict as latest_verdict
      FROM detection_jobs j
      LEFT JOIN LATERAL (
        SELECT score, verdict 
        FROM detection_results 
        WHERE job_id = j.id 
        ORDER BY created_at DESC 
        LIMIT 1
      ) latest_result ON true
      WHERE j.org_id = $1
    `;
    let countQueryText = `SELECT COUNT(*) as total FROM detection_jobs WHERE org_id = $1`;
    const queryParams: any[] = [orgId];

    if (filters.status) {
      queryParams.push(filters.status);
      queryText += ` AND j.status = $${queryParams.length}`;
      countQueryText += ` AND status = $${queryParams.length}`;
    }

    if (filters.contentType) {
      queryParams.push(filters.contentType);
      queryText += ` AND j.content_type = $${queryParams.length}`;
      countQueryText += ` AND content_type = $${queryParams.length}`;
    }

    // Append standard pagination
    const selectParams = [...queryParams];
    selectParams.push(limit);
    queryText += ` ORDER BY j.created_at DESC LIMIT $${selectParams.length}`;

    selectParams.push(offset);
    queryText += ` OFFSET $${selectParams.length}`;

    const [jobsRes, countRes] = await Promise.all([
      query(queryText, selectParams),
      query(countQueryText, queryParams),
    ]);

    const total = parseInt(countRes.rows[0]?.total || '0', 10);

    return {
      jobs: jobsRes.rows,
      total,
      page,
    };
  }

  /**
   * Mutates status state enforcing legal transitions and injecting timestamps automatically.
   */
  static async updateJobStatus(
    jobId: string,
    status: string,
    extras?: { errorMessage?: string; s3Key?: string },
  ): Promise<DetectionJob> {
    // 1. Fetch current job
    const fetchRes = await query(`SELECT * FROM detection_jobs WHERE id = $1`, [jobId]);
    const job = fetchRes.rows[0];
    if (!job) {
      throw new NotFoundError('Job record not found');
    }

    const currentStatus = job.status;

    // 2. Validate Transitions
    const allowedTransitions: Record<string, string[]> = {
      pending: ['queued', 'cancelled'],
      queued: ['processing', 'cancelled'],
      processing: ['completed', 'failed', 'cancelled'],
      completed: [],
      failed: [],
      cancelled: [],
    };

    if (currentStatus !== status) {
      const allowed = allowedTransitions[currentStatus] || [];
      if (!allowed.includes(status)) {
        throw new ValidationError(
          `Invalid job status transition from '${currentStatus}' to '${status}'`,
        );
      }
    }

    // 3. Build dynamic update query
    let updateSql = `UPDATE detection_jobs SET status = $1, updated_at = NOW()`;
    const params: any[] = [status];

    if (status === 'queued') {
      updateSql += `, queued_at = NOW()`;
    } else if (status === 'processing') {
      updateSql += `, started_at = NOW()`;
    } else if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      updateSql += `, completed_at = NOW()`;
    }

    if (extras?.errorMessage !== undefined) {
      params.push(extras.errorMessage);
      updateSql += `, error_message = $${params.length}`;
    }

    if (extras?.s3Key !== undefined) {
      params.push(extras.s3Key);
      updateSql += `, s3_key = $${params.length}`;
    }

    params.push(jobId);
    updateSql += ` WHERE id = $${params.length} RETURNING *`;

    const res = await query(updateSql, params);
    const updatedJob = res.rows[0];

    if (status === 'completed' && updatedJob) {
      await cacheService.invalidateOrgCache(updatedJob.org_id);
    }

    return updatedJob;
  }

  /**
   * Joins a job with all its associated detection results in the database.
   */
  static async getJobWithResults(jobId: string, orgId: string): Promise<JobWithResults | null> {
    // Scoped retrieval
    const job = await this.getJobById(jobId, orgId);
    if (!job) {
      return null;
    }

    const resultsRes = await query(
      `SELECT * FROM detection_results WHERE job_id = $1 AND org_id = $2 ORDER BY created_at ASC`,
      [jobId, orgId],
    );

    return {
      ...job,
      results: resultsRes.rows as DetectionResult[],
    };
  }
}
