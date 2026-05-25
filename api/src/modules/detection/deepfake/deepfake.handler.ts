import { query } from '../../../shared/database/pool.js';
import { env } from '../../../config/env.js';
import { DeepfakeAnalyzer } from './deepfake.analyzer.js';
import { logger } from '../../../utils/logger.js';

/**
 * Top-level handler for deepfake detection jobs consumed from the task queue.
 * Implements graceful degradation when API keys are not configured.
 */
export async function handleDeepfake(job: any): Promise<any> {
  const contentType = (job.content_type || '').toLowerCase();

  if (contentType !== 'image' && contentType !== 'video') {
    throw new Error(`Deepfake detection only supports image or video content, got: ${contentType}`);
  }

  // Graceful degradation: if Hive key not set, return a safe zero-score result
  if (!env.HIVE_MODERATION_API_KEY) {
    logger.warn('[Deepfake] Hive API key not configured — returning unavailable result');

    const unavailableResult = {
      score: 0,
      verdict: 'clean',
      confidence: 0,
      flags: ['deepfake_detection_unavailable'],
      details: {
        error: 'Hive API key not configured',
        contentType,
        framesAnalyzed: 0,
        facesDetected: 0,
        hiveAnalysis: null,
        frameAnalyses: [],
        worstFrameScore: 0,
        averageFrameScore: 0,
        manipulationIndicators: [],
      },
    };

    const dbResult = await query(
      `INSERT INTO detection_results (job_id, module, score, verdict, confidence, flags, model_version, result_data)
       VALUES ($1, 'deepfake', $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        job.id,
        unavailableResult.score,
        unavailableResult.verdict,
        unavailableResult.confidence,
        JSON.stringify(unavailableResult.flags),
        env.DEEPFAKE_MODEL_VERSION,
        JSON.stringify(unavailableResult),
      ]
    );

    return dbResult.rows[0];
  }

  const startTime = Date.now();
  const analyzer = new DeepfakeAnalyzer();
  const result = await analyzer.analyze(job);
  const processingMs = Date.now() - startTime;

  logger.info(
    `[Deepfake] Analysis complete in ${processingMs}ms — score: ${result.score}, verdict: ${result.verdict}`
  );

  const dbResult = await query(
    `INSERT INTO detection_results (job_id, module, score, verdict, confidence, flags, model_version, processing_time_ms, result_data)
     VALUES ($1, 'deepfake', $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      job.id,
      result.score,
      result.verdict,
      result.confidence,
      JSON.stringify(result.flags),
      env.DEEPFAKE_MODEL_VERSION,
      processingMs,
      JSON.stringify(result),
    ]
  );

  return dbResult.rows[0];
}
