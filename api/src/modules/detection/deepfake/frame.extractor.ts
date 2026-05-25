import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';
import * as path from 'path';
import fs from 'fs/promises';
import { logger } from '../../../utils/logger.js';
import { ExtractedFrame } from './deepfake.types.js';

export class FrameExtractor {
  /**
   * Retrieves the duration of a video using ffprobe.
   */
  async getVideoDuration(videoPath: string): Promise<number> {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          logger.warn(`ffprobe failed or not installed: ${err.message}. Defaulting duration to 10s for mocking.`);
          // Graceful fallback if ffprobe isn't globally configured in the system environment
          return resolve(10);
        }
        const duration = metadata?.format?.duration;
        if (duration !== undefined) {
          resolve(Number(duration));
        } else {
          resolve(10);
        }
      });
    });
  }

  /**
   * Extracts one frame at an exact timestamp.
   */
  async extractSingleFrame(
    videoPath: string,
    timestampSeconds: number,
    outputPath: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshot({
          timestamps: [timestampSeconds],
          filename: path.basename(outputPath),
          folder: path.dirname(outputPath),
        })
        .on('end', () => {
          resolve(outputPath);
        })
        .on('error', (err) => {
          logger.error(`ffmpeg single frame extract failed: ${err.message}`);
          reject(err);
        });
    });
  }

  /**
   * Extracts evenly distributed frames across the video and resizes them to 1024x1024 using sharp.
   */
  async extractFrames(
    videoPath: string,
    outputDir: string,
    maxFrames: number
  ): Promise<ExtractedFrame[]> {
    const extracted: ExtractedFrame[] = [];
    let duration = 10;
    try {
      duration = await this.getVideoDuration(videoPath);
    } catch (err: any) {
      logger.warn(`Failed to retrieve video duration: ${err.message}`);
    }

    const step = maxFrames > 1 ? duration / (maxFrames - 1) : duration;
    const timestamps: number[] = [];
    for (let i = 0; i < maxFrames; i++) {
      timestamps.push(Math.min(i * step, duration));
    }

    logger.info(`Extracting ${timestamps.length} keyframes at timestamps: ${timestamps.join(', ')}`);

    for (let index = 0; index < timestamps.length; index++) {
      const timestamp = timestamps[index];
      const rawFramePath = path.join(outputDir, `raw_frame_${index}.jpg`);
      const finalFramePath = path.join(outputDir, `frame_${index}.jpg`);

      try {
        await this.extractSingleFrame(videoPath, timestamp, rawFramePath);

        // Resize the extracted frame with sharp to meet Hive's 1024x1024 limit
        const imageBuffer = await fs.readFile(rawFramePath);
        const resizedBuffer = await sharp(imageBuffer)
          .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
          .toBuffer();

        await fs.writeFile(finalFramePath, resizedBuffer);

        // Remove raw high-res frame to save space
        await fs.unlink(rawFramePath).catch(() => {});

        extracted.push({
          timestamp,
          filePath: finalFramePath,
          frameIndex: index,
        });
      } catch (err: any) {
        logger.warn(`Failed to extract frame at timestamp ${timestamp}: ${err.message}`);
        // Cleanup raw frame if it was written partially
        await fs.unlink(rawFramePath).catch(() => {});
        await fs.unlink(finalFramePath).catch(() => {});
      }
    }

    return extracted;
  }
}
