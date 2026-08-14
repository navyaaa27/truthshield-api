import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { env } from '../../config/env.js';
import { ValidationError, ForbiddenError } from '../../middleware/errorHandler.js';
import { logger } from '../../utils/logger.js';

// Initialize S3 SDK client
export const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CF_R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.CF_R2_SECRET_ACCESS_KEY!,
  },
});

// Supported media types and categories
const SUPPORTED_MIMETYPES = {
  images: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  videos: ['video/mp4', 'video/quicktime', 'video/webm'],
  documents: ['application/pdf', 'text/plain', 'text/html'],
};

const ALL_SUPPORTED_MIMETYPES = [
  ...SUPPORTED_MIMETYPES.images,
  ...SUPPORTED_MIMETYPES.videos,
  ...SUPPORTED_MIMETYPES.documents,
];

/**
 * Validates that an S3 key begins with the authorized organization's prefix.
 */
export function verifyOrgScope(s3Key: string, orgId: string): void {
  if (!s3Key.startsWith(`${orgId}/`)) {
    throw new ForbiddenError(
      'Access to S3 asset outside authorized organization context is denied',
    );
  }
}

/**
 * Sanitizes a file name to remove path traversal characters and limit size to 100 characters.
 */
export function sanitizeFileName(fileName: string): string {
  let cleaned = fileName.replace(/(\.\.[\/\\])/g, ''); // Remove traversal sequences
  cleaned = cleaned.replace(/[\/\\]/g, '_'); // Replace path separators
  cleaned = cleaned.replace(/[^a-zA-Z0-9_.-]/g, '_'); // Replace unsafe characters

  if (cleaned.length > 100) {
    const ext = path.extname(cleaned);
    const base = path.basename(cleaned, ext);
    cleaned = base.substring(0, 100 - ext.length) + ext;
  }
  return cleaned;
}

export class S3Service {
  /**
   * Generates a pre-signed S3 upload URL valid for 15 minutes.
   */
  static async getPresignedUploadUrl(params: {
    orgId: string;
    jobId: string;
    fileName: string;
    mimeType: string;
    fileSizeBytes: number;
  }): Promise<{ uploadUrl: string; s3Key: string; expiresAt: Date }> {
    const { orgId, jobId, fileName, mimeType, fileSizeBytes } = params;

    // 1. Validation: MimeType Checks
    if (!ALL_SUPPORTED_MIMETYPES.includes(mimeType)) {
      throw new ValidationError(`Unsupported file type: ${mimeType}`);
    }

    // 2. Validation: Size Constraints
    let maxSize = 0;
    if (
      SUPPORTED_MIMETYPES.images.includes(mimeType) ||
      SUPPORTED_MIMETYPES.documents.includes(mimeType)
    ) {
      maxSize = env.MAX_FILE_SIZE_IMAGE_MB * 1024 * 1024;
    } else if (SUPPORTED_MIMETYPES.videos.includes(mimeType)) {
      maxSize = env.MAX_FILE_SIZE_VIDEO_MB * 1024 * 1024;
    }

    if (fileSizeBytes > maxSize) {
      throw new ValidationError(
        `File size exceeds the allowed limit for this type (max: ${maxSize / (1024 * 1024)}MB)`,
      );
    }

    // 3. Key construction
    const sanitized = sanitizeFileName(fileName);
    const s3Key = `${orgId}/jobs/${jobId}/${Date.now()}-${sanitized}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const command = new PutObjectCommand({
      Bucket: env.S3_BUCKET_NAME || 'truthshield-bucket',
      Key: s3Key,
      ContentType: mimeType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

    logger.info(`S3 presigned upload URL generated: ${s3Key} for Org: ${orgId}`);

    return {
      uploadUrl,
      s3Key,
      expiresAt,
    };
  }

  /**
   * Performs an S3 HeadObject request to confirm an uploaded file exists and retrieves its properties.
   */
  static async confirmUpload(
    s3Key: string,
    orgId?: string,
  ): Promise<{ exists: boolean; actualMimeType: string; fileSizeBytes: number }> {
    if (orgId) {
      verifyOrgScope(s3Key, orgId);
    }

    try {
      const command = new HeadObjectCommand({
        Bucket: env.S3_BUCKET_NAME || 'truthshield-bucket',
        Key: s3Key,
      });

      const meta = await s3Client.send(command);

      return {
        exists: true,
        actualMimeType: meta.ContentType || 'application/octet-stream',
        fileSizeBytes: meta.ContentLength || 0,
      };
    } catch (error: any) {
      logger.warn(`S3 HeadObject failed for key ${s3Key}: ${error.message}`);
      return {
        exists: false,
        actualMimeType: '',
        fileSizeBytes: 0,
      };
    }
  }

  /**
   * Generates an S3 pre-signed download GET URL for secure content retrieval.
   */
  static async getPresignedDownloadUrl(
    s3Key: string,
    orgId?: string,
    expirySeconds = 3600,
  ): Promise<string> {
    if (orgId) {
      verifyOrgScope(s3Key, orgId);
    }

    const command = new GetObjectCommand({
      Bucket: env.S3_BUCKET_NAME || 'truthshield-bucket',
      Key: s3Key,
    });

    return getSignedUrl(s3Client, command, { expiresIn: expirySeconds });
  }

  /**
   * Relocates an S3 object to the {orgId}/deleted/ folder partition (Soft-delete).
   */
  static async deleteFile(s3Key: string, orgId: string): Promise<void> {
    verifyOrgScope(s3Key, orgId);

    const parts = s3Key.split('/');
    const filename = parts[parts.length - 1];
    const newKey = `${orgId}/deleted/${Date.now()}-${filename}`;

    const bucketName = env.S3_BUCKET_NAME || 'truthshield-bucket';

    try {
      // 1. Copy original file to deleted partition
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: bucketName,
          CopySource: encodeURI(`${bucketName}/${s3Key}`),
          Key: newKey,
        }),
      );

      // 2. Delete original object
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: bucketName,
          Key: s3Key,
        }),
      );

      logger.info(`Asset soft-deleted: Relocated S3 Key ${s3Key} to ${newKey}`);
    } catch (error: any) {
      logger.error(`Failed to soft-delete S3 asset ${s3Key}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generates a 400x400 thumbnail for images or extracts a 1s frame for video streams.
   */
  static async generateThumbnail(s3Key: string, orgId?: string): Promise<string> {
    if (orgId) {
      verifyOrgScope(s3Key, orgId);
    }

    const bucketName = env.S3_BUCKET_NAME || 'truthshield-bucket';
    const thumbKey = `${s3Key}-thumb`;

    try {
      const downloadUrl = await this.getPresignedDownloadUrl(s3Key, undefined, 300);

      // Distinguish media category by extension
      const isVideo = /\.(mp4|mov|qt|webm)$/i.test(s3Key);

      if (!isVideo) {
        // --- Image Thumbnailing Workflow ---
        const response = await fetch(downloadUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch source image: ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const thumbBuffer = await sharp(buffer).resize(400, 400, { fit: 'cover' }).toBuffer();

        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: thumbKey,
            Body: thumbBuffer,
            ContentType: 'image/jpeg',
          }),
        );
      } else {
        // --- Video Thumbnailing Workflow ---
        const tempVideoPath = path.join(os.tmpdir(), `v-${Date.now()}.mp4`);
        const tempThumbPath = path.join(os.tmpdir(), `t-${Date.now()}.jpg`);

        // Fetch video stream locally to feed ffmpeg
        const response = await fetch(downloadUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch source video stream: ${response.statusText}`);
        }
        const fileStream = fs.createWriteStream(tempVideoPath);
        const arrayBuffer = await response.arrayBuffer();
        fs.writeFileSync(tempVideoPath, Buffer.from(arrayBuffer));
        fileStream.close();

        await new Promise<void>((resolve, reject) => {
          ffmpeg(tempVideoPath)
            .screenshots({
              timestamps: ['1'],
              filename: path.basename(tempThumbPath),
              folder: path.dirname(tempThumbPath),
              size: '400x400',
            })
            .on('end', () => resolve())
            .on('error', (err) => reject(err));
        });

        const thumbBuffer = fs.readFileSync(tempThumbPath);

        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: thumbKey,
            Body: thumbBuffer,
            ContentType: 'image/jpeg',
          }),
        );

        // Cleanup local temp mounts
        try {
          fs.unlinkSync(tempVideoPath);
          fs.unlinkSync(tempThumbPath);
        } catch {}
      }

      logger.info(`Thumbnail generated successfully: ${thumbKey}`);
      return thumbKey;
    } catch (error: any) {
      logger.warn(
        `Failed to generate thumbnail for ${s3Key}: ${error.message}. Returning default.`,
      );
      return thumbKey;
    }
  }
}
