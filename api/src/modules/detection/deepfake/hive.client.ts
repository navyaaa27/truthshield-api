import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs/promises';
import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { HiveAnalysisResult, HiveClass } from './deepfake.types.js';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class RateLimitError extends Error {
  retryAfter: number;
  constructor(message: string, retryAfter: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class ExternalServiceError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'ExternalServiceError';
    this.statusCode = statusCode;
  }
}

export class HiveClient {
  private apiUrl: string;
  private apiKey: string;

  constructor() {
    this.apiUrl = env.HIVE_MODERATION_API_URL || 'https://api.thehive.ai/api/v2';
    this.apiKey = env.HIVE_MODERATION_API_KEY || '';
  }

  /**
   * Analyzes a local image file for deepfake indicators via the Hive Moderation API.
   */
  async analyzeImage(imagePath: string): Promise<HiveAnalysisResult> {
    const startTime = Date.now();
    const fileBuffer = await fs.readFile(imagePath);

    const form = new FormData();
    form.append('media', fileBuffer, {
      filename: 'image.jpg',
      contentType: 'image/jpeg',
    });

    try {
      const response = await axios.post(
        `${this.apiUrl}/task/sync/deepfake_detection`,
        form,
        {
          headers: {
            Authorization: `Token ${this.apiKey}`,
            ...form.getHeaders(),
          },
          timeout: 30000, // 30 second timeout
        }
      );

      const duration = Date.now() - startTime;
      logger.info(`[Hive] API call completed in ${duration}ms, status: ${response.status}`);

      return this.parseHiveResponse(response.data);
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const status = err.response?.status;

      logger.error(`[Hive] API call failed after ${duration}ms, status: ${status || 'N/A'}`);

      if (status === 401) {
        throw new AuthError('Hive API key invalid or unauthorized');
      }
      if (status === 429) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '60', 10);
        throw new RateLimitError(`Hive API rate limit exceeded. Retry after ${retryAfter}s`, retryAfter);
      }
      if (status && status >= 500) {
        throw new ExternalServiceError(`Hive API server error: ${status}`, status);
      }

      throw err;
    }
  }

  /**
   * Analyzes an image from a public URL.
   */
  async analyzeImageFromUrl(imageUrl: string): Promise<HiveAnalysisResult> {
    const startTime = Date.now();

    try {
      const response = await axios.post(
        `${this.apiUrl}/task/sync/deepfake_detection`,
        { url: imageUrl },
        {
          headers: {
            Authorization: `Token ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      const duration = Date.now() - startTime;
      logger.info(`[Hive] URL analysis completed in ${duration}ms, status: ${response.status}`);

      return this.parseHiveResponse(response.data);
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const status = err.response?.status;

      logger.error(`[Hive] URL analysis failed after ${duration}ms, status: ${status || 'N/A'}`);

      if (status === 401) {
        throw new AuthError('Hive API key invalid or unauthorized');
      }
      if (status === 429) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '60', 10);
        throw new RateLimitError(`Hive API rate limit exceeded. Retry after ${retryAfter}s`, retryAfter);
      }
      if (status && status >= 500) {
        throw new ExternalServiceError(`Hive API server error: ${status}`, status);
      }

      throw err;
    }
  }

  /**
   * Parses the raw Hive API response into our standardized HiveAnalysisResult.
   */
  parseHiveResponse(rawResponse: any): HiveAnalysisResult {
    const classes: HiveClass[] = [];
    let deepfakeScore = 0;
    let faceSwapScore = 0;
    let ganGeneratedScore = 0;

    try {
      // Hive response format: { status: [...], output: [...] }
      const outputs = rawResponse?.status ?? rawResponse?.output ?? [];
      const resultArray = Array.isArray(outputs) ? outputs : [];

      for (const output of resultArray) {
        const outputClasses = output?.response?.output ?? output?.classes ?? [];
        for (const cls of outputClasses) {
          const className = (cls.class || '').toLowerCase();
          const score = typeof cls.score === 'number' ? cls.score : 0;

          classes.push({ class: className, score });

          if (className === 'deepfake' || className === 'yes') {
            deepfakeScore = Math.max(deepfakeScore, score);
          }
          if (className === 'face_swap') {
            faceSwapScore = Math.max(faceSwapScore, score);
          }
          if (className === 'gan_generated' || className === 'ai_generated') {
            ganGeneratedScore = Math.max(ganGeneratedScore, score);
          }
        }
      }
    } catch (parseErr: any) {
      logger.warn(`[Hive] Response parsing fallback triggered: ${parseErr.message}`);
    }

    return {
      deepfakeScore,
      faceSwapScore,
      ganGeneratedScore,
      classes,
      rawResponse,
    };
  }
}
