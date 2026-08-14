import {
  RekognitionClient as AWSRekognitionClient,
  DetectFacesCommand,
} from '@aws-sdk/client-rekognition';
import fs from 'fs/promises';
import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { RekognitionResult, FaceRegion } from './deepfake.types.js';
import { recordExternalApi } from '../../../shared/metrics/metrics.service.js';

export class RekognitionClient {
  private client: any;

  constructor() {
    this.client = new AWSRekognitionClient({
      region: env.AWS_REKOGNITION_REGION || 'us-east-1',
    });
  }

  /**
   * Detects faces in a local image file using AWS Rekognition.
   */
  async detectFaces(imagePath: string): Promise<RekognitionResult> {
    const imageBytes = await fs.readFile(imagePath);

    const command = new DetectFacesCommand({
      Image: { Bytes: imageBytes },
      Attributes: ['ALL'],
    });

    try {
      const response = await recordExternalApi('AWS_Rekognition', 'detectFaces', () =>
        this.client.send(command),
      );
      return this.mapResponse(response);
    } catch (err: any) {
      logger.error(`[Rekognition] detectFaces failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Detects faces from an S3 object reference (more efficient for large files).
   */
  async detectFacesFromS3(s3Key: string): Promise<RekognitionResult> {
    const bucket = (env as any).AWS_S3_BUCKET || 'truthshield-uploads';

    const command = new DetectFacesCommand({
      Image: {
        S3Object: {
          Bucket: bucket,
          Name: s3Key,
        },
      },
      Attributes: ['ALL'],
    });

    try {
      const response = await recordExternalApi('AWS_Rekognition', 'detectFacesFromS3', () =>
        this.client.send(command),
      );
      return this.mapResponse(response);
    } catch (err: any) {
      logger.error(`[Rekognition] detectFacesFromS3 failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Checks for suspicious face attributes that may indicate manipulation.
   */
  hasSuspiciousFaceAttributes(result: RekognitionResult): string[] {
    const flags: string[] = [];

    if (result.faceCount === 0) {
      return flags;
    }

    const qualities: number[] = [];

    for (const face of result.faces) {
      if (face.confidence < 80) {
        flags.push('low_face_confidence');
      }
    }

    // Check quality score (sharpness/brightness average)
    if (result.qualityScore < 50) {
      flags.push('low_sharpness');
    }

    // Check for inconsistent lighting across multiple faces
    if (result.faces.length >= 2) {
      const confidences = result.faces.map((f) => f.confidence);
      const maxConf = Math.max(...confidences);
      const minConf = Math.min(...confidences);

      if (maxConf - minConf > 30) {
        flags.push('lighting_inconsistency');
      }

      // Check for face quality mismatch
      for (const face of result.faces) {
        qualities.push(face.confidence);
      }
      const avgQuality = qualities.reduce((a, b) => a + b, 0) / qualities.length;
      const hasOutlier = qualities.some((q) => Math.abs(q - avgQuality) > 25);
      if (hasOutlier) {
        flags.push('face_quality_mismatch');
      }
    }

    // Deduplicate
    return [...new Set(flags)];
  }

  /**
   * Maps the raw AWS Rekognition response to our standardized RekognitionResult.
   */
  private mapResponse(response: any): RekognitionResult {
    const faceDetails = response.FaceDetails || [];

    const faces: FaceRegion[] = faceDetails.map((face: any, index: number) => {
      const box = face.BoundingBox || {};
      return {
        boundingBox: {
          top: box.Top || 0,
          left: box.Left || 0,
          width: box.Width || 0,
          height: box.Height || 0,
        },
        confidence: face.Confidence || 0,
        landmarks: face.Landmarks || null,
        faceIndex: index,
      };
    });

    // Calculate quality score: average of Sharpness + Brightness from face quality
    let qualityScore = 0;
    if (faceDetails.length > 0) {
      const qualityScores = faceDetails.map((face: any) => {
        const quality = face.Quality || {};
        const sharpness = quality.Sharpness || 0;
        const brightness = quality.Brightness || 0;
        return (sharpness + brightness) / 2;
      });
      qualityScore =
        qualityScores.reduce((a: number, b: number) => a + b, 0) / qualityScores.length;
    }

    return {
      faceCount: faceDetails.length,
      faces,
      qualityScore,
      rawResponse: response,
    };
  }
}
