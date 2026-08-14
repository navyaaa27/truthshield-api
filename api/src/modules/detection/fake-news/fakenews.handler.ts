import { query } from '../../../shared/database/pool.js';
import { env } from '../../../config/env.js';
import { FakeNewsAnalyzer } from './fakenews.analyzer.js';

/**
 * Top-level orchestration handler for fake news & misinformation detection.
 * Invoked by background queue workers when 'fake_news' module is requested.
 */
export async function handleFakeNews(job: any): Promise<any> {
  const startTime = Date.now();
  const jobId = job.id;
  const orgId = job.org_id;
  const contentType = job.content_type;

  // Retrieve input content from either source_url or source_metadata
  const sourceUrl = job.source_url || (job.source_metadata as any)?.sourceUrl || null;
  const rawText =
    (job.source_metadata as any)?.rawText || (job.source_metadata as any)?.text || null;

  if (!sourceUrl && !rawText) {
    throw new Error(
      `Job ${jobId} does not contain sourceUrl or rawText required for fake news verification.`,
    );
  }

  // 1. Run Analysis
  const analyzer = new FakeNewsAnalyzer();
  const result = await analyzer.analyze({ sourceUrl, rawText }, contentType);

  const processingTimeMs = Date.now() - startTime;

  // 2. Persist to detection_results table
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
    VALUES ($1, $2, 'fake_news', $3, $4, $5, $6, $7, $8::jsonb, $9)
    RETURNING *`,
    [
      jobId,
      orgId,
      result.score,
      result.verdict,
      result.confidence,
      env.FAKE_NEWS_MODEL_VERSION || 'fake-news-analyzer-v1.0',
      processingTimeMs,
      JSON.stringify(result),
      result.flags,
    ],
  );

  return dbRes.rows[0];
}
