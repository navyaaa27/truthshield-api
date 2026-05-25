import { query } from '../../../shared/database/pool.js';
import { env } from '../../../config/env.js';
import { StolenContentAnalyzer } from './stolen.analyzer.js';

/**
 * Top-level orchestration handler for stolen content & DMCA monitoring detection.
 */
export async function handleStolenContent(job: any): Promise<any> {
  const startTime = Date.now();
  const jobId = job.id;
  const orgId = job.org_id;
  const contentType = job.content_type;

  if (contentType !== 'image' && contentType !== 'video') {
    throw new Error(`Stolen content analysis is only supported for image or video content types. Received: ${contentType}`);
  }

  // 1. Execute analysis
  const analyzer = new StolenContentAnalyzer();
  const result = await analyzer.analyze(job);

  const processingTimeMs = Date.now() - startTime;

  // 2. Persist to database
  const dbRes = await query(
    `INSERT INTO detection_results (
      job_id,
      org_id,
      module,
      score,
      verdict,
      confidence,
      model_version,
      processing_time_ms,
      result_data,
      flags
    )
    VALUES ($1, $2, 'stolen_content', $3, $4, $5, $6, $7, $8::jsonb, $9)
    RETURNING *`,
    [
      jobId,
      orgId,
      result.score,
      result.verdict,
      result.confidence,
      env.STOLEN_CONTENT_MODEL_VERSION || 'stolen-content-analyzer-v1.0',
      processingTimeMs,
      JSON.stringify(result.details),
      result.flags,
    ]
  );

  return dbRes.rows[0];
}
