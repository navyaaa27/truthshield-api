import { query } from '../../../shared/database/pool.js';
import { MetadataTamperingAnalyzer } from './metadata.analyzer.js';

/**
 * Top-level orchestration handler for metadata tampering detection.
 * Called by the queue worker to process jobs asynchronously.
 */
export async function handleMetadataTampering(job: any): Promise<any> {
  const startTime = Date.now();
  const jobId = job.id;
  const orgId = job.org_id;
  const s3Key = job.s3_key;
  const contentType = job.content_type;

  if (!s3Key) {
    throw new Error(`Job ${jobId} does not have a valid s3_key for analysis`);
  }

  // 1. Instantiate analyzer and perform complete check
  const analyzer = new MetadataTamperingAnalyzer();
  const analysisResult = await analyzer.analyze(s3Key, contentType);

  const processingTimeMs = Date.now() - startTime;

  // 2. Save complete report to the detection_results table
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
    VALUES ($1, $2, 'metadata_tampering', $3, $4, $5, 'metadata-analyzer-v1.0', $6, $7::jsonb, $8)
    RETURNING *`,
    [
      jobId,
      orgId,
      analysisResult.score,
      analysisResult.verdict,
      analysisResult.confidence,
      processingTimeMs,
      JSON.stringify(analysisResult.details),
      analysisResult.flags,
    ]
  );

  return dbRes.rows[0];
}
