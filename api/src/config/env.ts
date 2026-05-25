import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env file
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url().describe('PostgreSQL database connection URL'),
  REDIS_URL: z.string().url().describe('Redis connection URL'),
  JWT_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  TOTP_ISSUER: z.string().default('TruthShieldAI'),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default(''),
  AWS_SECRET_ACCESS_KEY: z.string().default(''),
  S3_BUCKET_NAME: z.string().default(''),
  S3_PRESIGNED_URL_EXPIRY: z.coerce.number().default(3600),
  MAX_FILE_SIZE_IMAGE_MB: z.coerce.number().default(50),
  MAX_FILE_SIZE_VIDEO_MB: z.coerce.number().default(500),
  QUEUE_CONCURRENCY: z.coerce.number().default(5),
  QUEUE_MAX_RETRIES: z.coerce.number().default(3),
  QUEUE_RETRY_DELAY_MS: z.coerce.number().default(5000),
  BULL_BOARD_ENABLED: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),
  ADMIN_SECRET: z.string().default('admin-secret-key-12345'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default('alerts@truthshield.ai'),
  SLACK_WEBHOOK_URL: z.string().default(''),
  ALERT_SCORE_THRESHOLD_LOW: z.coerce.number().default(25),
  ALERT_SCORE_THRESHOLD_MEDIUM: z.coerce.number().default(50),
  ALERT_SCORE_THRESHOLD_HIGH: z.coerce.number().default(75),
  ALERT_SCORE_THRESHOLD_CRITICAL: z.coerce.number().default(90),
  ANTHROPIC_API_KEY: z.string().default(''),
  GOOGLE_FACT_CHECK_API_KEY: z.string().default(''),
  GOOGLE_FACT_CHECK_API_URL: z.string().default('https://factchecktools.googleapis.com/v1alpha1/claims:search'),
  NEWS_CREDIBILITY_THRESHOLD: z.coerce.number().default(60),
  FAKE_NEWS_MODEL_VERSION: z.string().default('fake-news-analyzer-v1.0'),
  PHASH_SIMILARITY_THRESHOLD: z.coerce.number().default(90),
  CONTENT_CRAWL_TIMEOUT_MS: z.coerce.number().default(8000),
  DMCA_TEMPLATE_VERSION: z.string().default('v1'),
  STOLEN_CONTENT_MODEL_VERSION: z.string().default('stolen-content-analyzer-v1.0'),
  HIVE_MODERATION_API_KEY: z.string().default(''),
  HIVE_MODERATION_API_URL: z.string().default('https://api.thehive.ai/api/v2'),
  AWS_REKOGNITION_REGION: z.string().default('us-east-1'),
  DEEPFAKE_CONFIDENCE_THRESHOLD: z.coerce.number().default(0.65),
  MAX_VIDEO_FRAMES_TO_ANALYZE: z.coerce.number().default(10),
  DEEPFAKE_MODEL_VERSION: z.string().default('deepfake-analyzer-v1.0'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;
