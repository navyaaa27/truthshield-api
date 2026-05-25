import fs from 'fs/promises';
import * as path from 'path';
import { S3Service } from '../../../shared/storage/s3.service.js';
import { createTempDir, cleanupTempDir } from '../../../utils/tempFiles.js';
import { logger } from '../../../utils/logger.js';
import { env } from '../../../config/env.js';
import { HiveClient } from './hive.client.js';
import { RekognitionClient } from './rekognition.client.js';
import { FrameExtractor } from './frame.extractor.js';
import {
  DeepfakeResult,
  HiveAnalysisResult,
  RekognitionResult,
  FrameAnalysis,
} from './deepfake.types.js';

export class DeepfakeAnalyzer {
  private hiveClient = new HiveClient();
  private rekognitionClient = new RekognitionClient();
  private frameExtractor = new FrameExtractor();

  /**
   * Main entry point — orchestrates deepfake analysis for images or videos.
   */
  async analyze(job: any): Promise<DeepfakeResult> {
    if (!job.s3_key) {
      throw new Error('Job must have an s3_key for deepfake analysis');
    }

    const contentType = (job.content_type || '').toLowerCase();
    if (contentType !== 'image' && contentType !== 'video') {
      throw new Error(`Deepfake analysis only supports image or video, got: ${contentType}`);
    }

    const tempDir = await createTempDir('deepfake-analysis');
    const filePath = path.join(tempDir, path.basename(job.s3_key));

    try {
      // Download file from S3
      logger.info(`[Deepfake] Downloading file from S3: ${job.s3_key}`);
      await this.downloadToTemp(job.s3_key, filePath);

      if (contentType === 'image') {
        return await this.analyzeImage(filePath, job);
      } else {
        return await this.analyzeVideo(filePath, tempDir, job);
      }
    } finally {
      await cleanupTempDir(tempDir).catch(() => {});
    }
  }

  /**
   * Analyzes a single image for deepfake indicators.
   */
  private async analyzeImage(filePath: string, _job: any): Promise<DeepfakeResult> {
    let hiveResult: HiveAnalysisResult | null = null;
    let rekognitionResult: RekognitionResult | null = null;

    // Run both APIs in parallel
    const [hiveOutcome, rekognitionOutcome] = await Promise.allSettled([
      this.hiveClient.analyzeImage(filePath),
      this.rekognitionClient.detectFaces(filePath),
    ]);

    if (hiveOutcome.status === 'fulfilled') {
      hiveResult = hiveOutcome.value;
    } else {
      logger.warn(`[Deepfake] Hive analysis failed: ${hiveOutcome.reason?.message}`);
    }

    if (rekognitionOutcome.status === 'fulfilled') {
      rekognitionResult = rekognitionOutcome.value;
    } else {
      logger.warn(`[Deepfake] Rekognition analysis failed: ${rekognitionOutcome.reason?.message}`);
    }

    // If both fail, return low-confidence uncertain result
    if (!hiveResult && !rekognitionResult) {
      return this.buildUncertainResult('image');
    }

    const score = this.calculateImageScore(hiveResult, rekognitionResult);
    const flags = this.buildFlags(hiveResult, rekognitionResult, score, null);
    const confidence = this.calculateConfidence(hiveResult, rekognitionResult, null);
    const facesDetected = rekognitionResult?.faceCount ?? 0;

    // Collect manipulation indicators from Rekognition
    const manipulationIndicators = rekognitionResult
      ? this.rekognitionClient.hasSuspiciousFaceAttributes(rekognitionResult)
      : [];

    return {
      score,
      verdict: this.determineVerdict(score),
      confidence,
      flags,
      details: {
        contentType: 'image',
        framesAnalyzed: 1,
        facesDetected,
        hiveAnalysis: hiveResult,
        frameAnalyses: [],
        worstFrameScore: score,
        averageFrameScore: score,
        manipulationIndicators,
      },
    };
  }

  /**
   * Analyzes a video by extracting frames and processing each sequentially.
   */
  private async analyzeVideo(
    filePath: string,
    tempDir: string,
    job: any
  ): Promise<DeepfakeResult> {
    const maxFrames = env.MAX_VIDEO_FRAMES_TO_ANALYZE || 10;
    const framesDir = path.join(tempDir, 'frames');
    await fs.mkdir(framesDir, { recursive: true });

    const extractedFrames = await this.frameExtractor.extractFrames(filePath, framesDir, maxFrames);

    if (extractedFrames.length === 0) {
      logger.warn('[Deepfake] No frames could be extracted from the video');
      return this.buildUncertainResult('video');
    }

    const frameAnalyses: FrameAnalysis[] = [];
    let totalFaces = 0;
    let overallHiveResult: HiveAnalysisResult | null = null;

    // Analyze each frame sequentially (respect API rate limits)
    for (const frame of extractedFrames) {
      let hiveResult: HiveAnalysisResult | null = null;
      let rekognitionResult: RekognitionResult | null = null;

      try {
        hiveResult = await this.hiveClient.analyzeImage(frame.filePath);
        if (!overallHiveResult) overallHiveResult = hiveResult;
      } catch (err: any) {
        logger.warn(`[Deepfake] Hive failed for frame ${frame.frameIndex}: ${err.message}`);
      }

      // 500ms delay between Hive calls to respect rate limits
      await this.delay(500);

      try {
        rekognitionResult = await this.rekognitionClient.detectFaces(frame.filePath);
        totalFaces += rekognitionResult.faceCount;
      } catch (err: any) {
        logger.warn(`[Deepfake] Rekognition failed for frame ${frame.frameIndex}: ${err.message}`);
      }

      const frameScore = this.calculateFrameScore(hiveResult, rekognitionResult);

      frameAnalyses.push({
        frameIndex: frame.frameIndex,
        timestampSeconds: frame.timestamp,
        s3Key: job.s3_key,
        hiveResult,
        rekognitionResult,
        frameScore,
      });

      // Cleanup frame temp file immediately after analysis
      await fs.unlink(frame.filePath).catch(() => {});
    }

    const frameScores = frameAnalyses.map((f) => f.frameScore);
    const worstFrameScore = Math.max(...frameScores);
    const averageFrameScore =
      frameScores.reduce((a, b) => a + b, 0) / frameScores.length;

    // Weighted final score: 60% worst frame, 40% average
    const finalScore = Math.round(worstFrameScore * 0.6 + averageFrameScore * 0.4);
    const clampedScore = Math.min(100, Math.max(0, finalScore));

    const flags = this.buildFlags(overallHiveResult, null, clampedScore, worstFrameScore);
    const confidence = this.calculateConfidence(
      overallHiveResult,
      null,
      extractedFrames.length
    );

    // Collect manipulation indicators across all frame results
    const allIndicators: string[] = [];
    for (const fa of frameAnalyses) {
      if (fa.rekognitionResult) {
        const indicators = this.rekognitionClient.hasSuspiciousFaceAttributes(fa.rekognitionResult);
        allIndicators.push(...indicators);
      }
    }

    return {
      score: clampedScore,
      verdict: this.determineVerdict(clampedScore),
      confidence,
      flags,
      details: {
        contentType: 'video',
        framesAnalyzed: frameAnalyses.length,
        facesDetected: totalFaces,
        hiveAnalysis: overallHiveResult,
        frameAnalyses,
        worstFrameScore,
        averageFrameScore: Math.round(averageFrameScore),
        manipulationIndicators: [...new Set(allIndicators)],
      },
    };
  }

  /**
   * Scores an image based on combined Hive + Rekognition signals.
   */
  calculateImageScore(
    hive: HiveAnalysisResult | null,
    rekognition: RekognitionResult | null
  ): number {
    // If no faces detected — can't be a deepfake
    if (rekognition && rekognition.faceCount === 0) {
      return 10;
    }

    let score = 0;

    if (hive) {
      // Primary signal: Hive deepfake score
      score = Math.round(hive.deepfakeScore * 100);

      if (hive.faceSwapScore > 0.7) score += 20;
      if (hive.ganGeneratedScore > 0.7) score += 15;
    }

    if (rekognition) {
      const suspiciousFlags = this.rekognitionClient.hasSuspiciousFaceAttributes(rekognition);
      if (suspiciousFlags.includes('face_quality_mismatch')) score += 15;
      if (suspiciousFlags.includes('lighting_inconsistency')) score += 10;
      if (suspiciousFlags.includes('low_face_confidence')) score += 5;
    }

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Scores a single video frame.
   */
  calculateFrameScore(
    hive: HiveAnalysisResult | null,
    rekognition: RekognitionResult | null
  ): number {
    if (!hive && !rekognition) return 0;
    return this.calculateImageScore(hive, rekognition);
  }

  /**
   * Determines the verdict string from the numeric score.
   */
  private determineVerdict(score: number): string {
    if (score <= 25) return 'clean';
    if (score <= 50) return 'suspicious';
    if (score <= 75) return 'requires_review';
    return 'manipulated';
  }

  /**
   * Builds the flags array from analysis results.
   */
  private buildFlags(
    hive: HiveAnalysisResult | null,
    rekognition: RekognitionResult | null,
    _score: number,
    worstFrameScore: number | null
  ): string[] {
    const flags: string[] = [];

    if (hive) {
      if (hive.deepfakeScore > 0.8) flags.push('high_deepfake_probability');
      if (hive.faceSwapScore > 0.7) flags.push('face_swap_detected');
      if (hive.ganGeneratedScore > 0.7) flags.push('ai_generated_face');
    }

    if (worstFrameScore !== null && worstFrameScore > 80) {
      flags.push('suspicious_frame_detected');
    }

    if (rekognition && rekognition.faceCount === 0) {
      flags.push('no_face_detected');
    }

    return [...new Set(flags)];
  }

  /**
   * Calculates confidence based on which APIs succeeded and frame count.
   */
  private calculateConfidence(
    hive: HiveAnalysisResult | null,
    rekognition: RekognitionResult | null,
    frameCount: number | null
  ): number {
    let confidence: number;

    if (hive && rekognition) {
      confidence = 90;
    } else if (hive) {
      confidence = 70;
    } else if (rekognition) {
      confidence = 55;
    } else {
      confidence = 20;
    }

    // Penalty for very few video frames
    if (frameCount !== null && frameCount < 3) {
      confidence -= 10;
    }

    return Math.max(0, confidence);
  }

  /**
   * Returns a low-confidence uncertain result when both APIs fail.
   */
  private buildUncertainResult(contentType: 'image' | 'video'): DeepfakeResult {
    return {
      score: 0,
      verdict: 'clean',
      confidence: 20,
      flags: ['analysis_incomplete'],
      details: {
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
  }

  /**
   * Downloads a file from S3 to a local temp path.
   */
  private async downloadToTemp(s3Key: string, filePath: string): Promise<void> {
    const downloadUrl = await S3Service.getPresignedDownloadUrl(s3Key);
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`S3 download failed: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(filePath, Buffer.from(arrayBuffer));
  }

  /**
   * Utility delay for rate-limiting.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
