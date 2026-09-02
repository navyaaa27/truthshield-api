import { promises as fs } from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import exifr from 'exifr';
import { Jimp } from 'jimp';
import { redis } from '../../../shared/redis/index.js';
import { S3Service } from '../../../shared/storage/s3.service.js';
import { logger } from '../../../utils/logger.js';
import { createTempDir, cleanupTempDir } from '../../../utils/tempFiles.js';
import {
  ExifAnalysis,
  ELAAnalysis,
  HashVerification,
  MetadataTamperingResult,
} from './metadata.types.js';

const EDITING_SOFTWARE = [
  'photoshop',
  'gimp',
  'lightroom',
  'canva',
  'paint.net',
  'pixelmator',
  'illustrator',
  'coreldraw',
  'acorn',
  'affinity',
  'fotor',
  'pixlr',
];

export class MetadataTamperingAnalyzer {
  /**
   * Orchestrates the complete metadata tampering analysis workflow.
   */
  async analyze(s3Key: string, contentType: string): Promise<MetadataTamperingResult> {
    const tempDir = await createTempDir('metadata-analysis');
    const filePath = path.join(tempDir, path.basename(s3Key));

    try {
      // 1. Download file from S3 to temp workspace using pre-signed GET URL
      logger.info(`[MetadataTampering] Fetching file from S3: ${s3Key}`);
      const downloadUrl = await S3Service.getPresignedDownloadUrl(s3Key);

      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Failed to download file from S3: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const fileBuffer = Buffer.from(arrayBuffer);
      await fs.writeFile(filePath, fileBuffer);

      // 2. Measure main image dimensions beforehand for aspect-ratio checks
      let mainWidth: number | undefined;
      let mainHeight: number | undefined;

      const isImage = contentType.toLowerCase().startsWith('image/');
      if (isImage) {
        try {
          const img = await Jimp.read(filePath);
          mainWidth = img.bitmap.width;
          mainHeight = img.bitmap.height;
        } catch (err) {
          logger.warn(`[MetadataTampering] Failed to pre-parse image dimensions: ${err}`);
        }
      }

      // 3. Run all sub-analyzers in parallel with crash-resiliency
      let analyzersRunCount = 0;

      const [exif, ela, hash] = await Promise.all([
        this.analyzeExif(filePath, mainWidth, mainHeight)
          .then((res) => {
            analyzersRunCount++;
            return res;
          })
          .catch((err) => {
            logger.error(`[MetadataTampering] EXIF sub-analyzer failed: ${err.message}`);
            return { flags: [] } as ExifAnalysis;
          }),

        this.analyzeELA(filePath, contentType)
          .then((res) => {
            analyzersRunCount++;
            return res;
          })
          .catch((err) => {
            logger.error(`[MetadataTampering] ELA sub-analyzer failed: ${err.message}`);
            return {
              suspiciousRegions: false,
              meanDiff: 0,
              stdDev: 0,
              elaScore: 0,
              skipped: true,
              reason: 'failed',
            } as ELAAnalysis;
          }),

        this.verifyHash(filePath, s3Key)
          .then((res) => {
            analyzersRunCount++;
            return res;
          })
          .catch((err) => {
            logger.error(`[MetadataTampering] Hash verification failed: ${err.message}`);
            return { sha256: '', hashChanged: false } as HashVerification;
          }),
      ]);

      // 4. Calculate aggregated score and verdict parameters
      const { score, verdict, confidence } = this.calculateFinalScore(
        exif,
        ela,
        hash,
        analyzersRunCount,
      );

      // 5. Gather unique flags and inconsistency messages
      const flags = Array.from(
        new Set([
          ...exif.flags,
          ...(ela.elaScore > 25 ? ['high_variance_ela'] : []),
          ...(ela.suspiciousRegions ? ['localized_ela_irregularity'] : []),
          ...(hash.hashChanged ? ['file_hash_altered'] : []),
        ]),
      );

      const inconsistencies: string[] = [];
      if (exif.flags.includes('editing_software_detected')) {
        inconsistencies.push(
          `Editing software signature detected in EXIF metadata: '${exif.software}'.`,
        );
      }
      if (exif.flags.includes('gps_inconsistent')) {
        inconsistencies.push(
          'GPS location coordinates do not align with metadata location claims.',
        );
      }
      if (exif.flags.includes('metadata_modification_gap')) {
        inconsistencies.push(
          `Creation date and Modification date discrepancy detected (Create: ${exif.createDate}, Modify: ${exif.modifyDate}).`,
        );
      }
      if (exif.flags.includes('missing_expected_exif_fields')) {
        inconsistencies.push(
          'Standard camera-generated tags are missing from camera model metadata.',
        );
      }
      if (exif.flags.includes('thumbnail_dimension_mismatch')) {
        inconsistencies.push('Aspect ratio of embedded EXIF thumbnail mismatches the main image.');
      }
      if (ela.elaScore > 25 && !ela.skipped) {
        inconsistencies.push(
          `High pixel compression variance detected (ELA StdDev: ${ela.elaScore.toFixed(2)}).`,
        );
      }
      if (ela.suspiciousRegions && !ela.skipped) {
        inconsistencies.push(
          'Localized high-frequency re-compression pattern detected (possible copy-paste splice).',
        );
      }
      if (hash.hashChanged) {
        inconsistencies.push(
          `SHA-256 hash changed on re-analysis from previously recorded state (Prev: ${hash.previousHash}, Current: ${hash.sha256}).`,
        );
      }

      return {
        score,
        verdict,
        confidence,
        flags,
        details: {
          exifAnalysis: exif,
          elaAnalysis: ela,
          hashVerification: hash,
          inconsistencies,
        },
      };
    } finally {
      // 6. Guarantee temp file workspace cleanup
      await cleanupTempDir(tempDir);
    }
  }

  /**
   * Parses and flags inconsistent EXIF properties.
   */
  private async analyzeExif(
    filePath: string,
    mainWidth?: number,
    mainHeight?: number,
  ): Promise<ExifAnalysis> {
    const flags: string[] = [];

    // Parse EXIF tags using exifr
    const exif = await exifr
      .parse(filePath, {
        tiff: true,
        xmp: true,
        gps: true,
      })
      .catch(() => null);

    if (!exif) {
      return { flags };
    }

    const rawSoftware = exif.Software || exif.software;
    const software =
      typeof rawSoftware === 'string'
        ? rawSoftware
        : rawSoftware
          ? String(rawSoftware)
          : undefined;

    const rawModel = exif.Model || exif.Make || exif.model || exif.make;
    const cameraModel =
      typeof rawModel === 'string' ? rawModel : rawModel ? String(rawModel) : undefined;

    const createDate = exif.CreateDate || exif.DateTimeOriginal || undefined;
    const modifyDate = exif.ModifyDate || exif.DateTime || undefined;

    let gpsData: { latitude: number; longitude: number } | undefined;
    if (exif.latitude !== undefined && exif.longitude !== undefined) {
      gpsData = {
        latitude: Number(exif.latitude),
        longitude: Number(exif.longitude),
      };
    }

    // 1. Flag: Editing software detected
    if (software) {
      const lowerSoftware = software.toLowerCase();
      const hasEditingSoftware = EDITING_SOFTWARE.some((s) => lowerSoftware.includes(s));
      if (hasEditingSoftware) {
        flags.push('editing_software_detected');
      }
    }


    // 2. Flag: GPS coordinates inconsistent with metadata location claims
    // We flag if GPS coordinates exist but metadata tags like City/Country indicate otherwise (e.g. mock claims)
    if (gpsData) {
      const hasClaim = exif.City || exif.Country || exif.Location;
      if (hasClaim) {
        // Simple mock validation rule: if latitude is exactly 0 or mismatches text length
        const claimText = `${exif.City || ''} ${exif.Country || ''}`;
        if (
          claimText.length > 0 &&
          Math.abs(gpsData.latitude) < 0.1 &&
          Math.abs(gpsData.longitude) < 0.1
        ) {
          flags.push('gps_inconsistent');
        }
      }
    }

    // 3. Flag: CreateDate vs ModifyDate gap > 0
    if (createDate && modifyDate) {
      const cTime = new Date(createDate).getTime();
      const mTime = new Date(modifyDate).getTime();
      if (!isNaN(cTime) && !isNaN(mTime) && mTime - cTime > 1000) {
        flags.push('metadata_modification_gap');
      }
    }

    // 4. Flag: Missing expected EXIF fields for camera model
    if (cameraModel) {
      const expectedFields = ['FocalLength', 'ExposureTime', 'FNumber', 'ISO', 'ISOSpeedRatings'];
      const hasExpected = expectedFields.some((f) => exif[f] !== undefined);
      if (!hasExpected) {
        flags.push('missing_expected_exif_fields');
      }
    }

    // 5. Flag: Thumbnail dimensions do not match main image aspect ratio
    const thumbWidth = exif.ThumbnailWidth || exif.ThumbnailImageWidth;
    const thumbHeight = exif.ThumbnailHeight || exif.ThumbnailImageHeight;
    if (thumbWidth && thumbHeight && mainWidth && mainHeight) {
      const mainRatio = mainWidth / mainHeight;
      const thumbRatio = thumbWidth / thumbHeight;
      if (Math.abs(mainRatio - thumbRatio) > 0.05) {
        flags.push('thumbnail_dimension_mismatch');
      }
    }

    return {
      flags,
      software,
      cameraModel,
      createDate: createDate ? new Date(createDate).toISOString() : undefined,
      modifyDate: modifyDate ? new Date(modifyDate).toISOString() : undefined,
      gpsData,
    };
  }

  /**
   * Performs Error Level Analysis (ELA) by identifying compression discrepancies.
   */
  private async analyzeELA(filePath: string, contentType: string): Promise<ELAAnalysis> {
    const isJpeg =
      /\.(jpg|jpeg)$/i.test(filePath) ||
      contentType === 'image/jpeg' ||
      contentType === 'image/jpg';
    if (!isJpeg) {
      return {
        suspiciousRegions: false,
        meanDiff: 0,
        stdDev: 0,
        elaScore: 0,
        skipped: true,
        reason: 'not_jpeg',
      };
    }

    const tempRefPath = path.join(path.dirname(filePath), `ref_ela_${Date.now()}.jpg`);
    try {
      // 1. Read original, clone, and save copy at quality 75
      const original = await Jimp.read(filePath);
      // @ts-ignore
      await (original.clone() as any).quality(75).write(tempRefPath);

      // 2. Read back reference copy to ensure compression artifacts are introduced
      const reference = await Jimp.read(tempRefPath);

      const width = original.bitmap.width;
      const height = original.bitmap.height;
      const origData = original.bitmap.data;
      const refData = reference.bitmap.data;

      let sumDiff = 0;
      const pixelCount = width * height;
      const diffs: number[] = new Array(pixelCount);

      // 3. Compute absolute pixel-level difference amplified 10x
      for (let i = 0; i < pixelCount; i++) {
        const idx = i * 4;
        const origR = origData[idx];
        const origG = origData[idx + 1];
        const origB = origData[idx + 2];

        const refR = refData[idx];
        const refG = refData[idx + 1];
        const refB = refData[idx + 2];

        const diffR = Math.min(Math.abs(origR - refR) * 10, 255);
        const diffG = Math.min(Math.abs(origG - refG) * 10, 255);
        const diffB = Math.min(Math.abs(origB - refB) * 10, 255);

        const diffVal = (diffR + diffG + diffB) / 3;
        diffs[i] = diffVal;
        sumDiff += diffVal;
      }

      // 4. Calculate mean difference and standard deviation
      const meanDiff = sumDiff / pixelCount;

      let sumSqDiff = 0;
      for (let i = 0; i < pixelCount; i++) {
        const diff = diffs[i] - meanDiff;
        sumSqDiff += diff * diff;
      }
      const stdDev = Math.sqrt(sumSqDiff / pixelCount);

      // 5. Look for localized re-compression anomalies (16x16 blocks)
      let suspiciousRegions = false;
      const blockSize = 16;
      const blocksX = Math.floor(width / blockSize);
      const blocksY = Math.floor(height / blockSize);

      for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
          let blockSum = 0;
          for (let y = 0; y < blockSize; y++) {
            for (let x = 0; x < blockSize; x++) {
              const pixelX = bx * blockSize + x;
              const pixelY = by * blockSize + y;
              const idx = pixelY * width + pixelX;
              blockSum += diffs[idx];
            }
          }
          const blockMean = blockSum / (blockSize * blockSize);
          // If block difference is significantly higher than average and absolute variance thresholds
          if (blockMean > meanDiff + 3 * stdDev && blockMean > 40) {
            suspiciousRegions = true;
            break;
          }
        }
        if (suspiciousRegions) break;
      }

      return {
        suspiciousRegions,
        meanDiff,
        stdDev,
        elaScore: stdDev, // Standard deviation serves as the overall ELA metric
      };
    } finally {
      // Cleanup reference image immediately
      try {
        await fs.unlink(tempRefPath);
      } catch {}
    }
  }

  /**
   * Tracks and compares the SHA-256 hash against previously recorded states in Redis.
   */
  private async verifyHash(filePath: string, s3Key: string): Promise<HashVerification> {
    const fileBuffer = await fs.readFile(filePath);
    const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    const redisKey = `hash:${s3Key}`;
    const previousHash = (await redis.get(redisKey)) || undefined;

    let hashChanged = false;
    if (previousHash && previousHash !== sha256) {
      hashChanged = true;
    }

    // Persist or renew hash state with a 30-day TTL (seconds)
    await redis.set(redisKey, sha256, 'EX', 30 * 24 * 60 * 60);

    return {
      sha256,
      previousHash,
      hashChanged,
    };
  }

  /**
   * Computes the aggregated final score, qualitative verdict, and confidence rating.
   */
  private calculateFinalScore(
    exif: ExifAnalysis,
    ela: ELAAnalysis,
    hash: HashVerification,
    analyzersRunCount: number,
  ): {
    score: number;
    verdict: 'clean' | 'suspicious' | 'requires_review' | 'manipulated';
    confidence: number;
  } {
    let score = 0;

    // 1. EXIF flags: +8 per flag
    score += exif.flags.length * 8;

    // 2. ELA Score (stdDev threshold additions)
    if (!ela.skipped) {
      if (ela.elaScore > 75) {
        score += 45;
      } else if (ela.elaScore > 50) {
        score += 25;
      }

      // Localized difference regions found gives additional +10 points
      if (ela.suspiciousRegions) {
        score += 15;
      }
    }

    // 3. Hash verification change: +30 points
    if (hash.hashChanged) {
      score += 30;
    }

    // 4. Editing software signature detected: +15 points
    if (exif.flags.includes('editing_software_detected')) {
      score += 15;
    }

    // Cap score at 100
    const finalScore = Math.min(score, 100);

    // 5. Verdict thresholds mapping
    let verdict: 'clean' | 'suspicious' | 'requires_review' | 'manipulated' = 'clean';
    if (finalScore >= 76) {
      verdict = 'manipulated';
    } else if (finalScore >= 51) {
      verdict = 'requires_review';
    } else if (finalScore >= 26) {
      verdict = 'suspicious';
    }

    // 6. Confidence rating
    let confidence = 0.4;
    if (analyzersRunCount === 3) {
      confidence = 0.9;
    } else if (analyzersRunCount === 2) {
      confidence = 0.65;
    }

    return {
      score: finalScore,
      verdict,
      confidence,
    };
  }
}
