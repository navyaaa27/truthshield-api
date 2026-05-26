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
  REDIS_TTL_SHORT: z.coerce.number().default(60),
  REDIS_TTL_MEDIUM: z.coerce.number().default(300),
  REDIS_TTL_LONG: z.coerce.number().default(3600),
  REDIS_TTL_DAY: z.coerce.number().default(86400),
  CACHE_ENABLED: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_SKIP_TRUSTED_IPS: z.string().default('127.0.0.1,::1'),
  API_KEY_RATE_LIMIT_PER_MIN: z.coerce.number().default(100),
  ABUSE_BAN_DURATION_HOURS: z.coerce.number().default(24),
  SUSPICIOUS_REQUEST_THRESHOLD: z.coerce.number().default(50),
  ALLOWED_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.string().default('info'),
  CLOUDWATCH_LOG_GROUP: z.string().default('/truthshield/api'),
  CLOUDWATCH_REGION: z.string().default('us-east-1'),
  METRICS_ENABLED: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),
  METRICS_SECRET: z.string().default('super-secret-metrics-key'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
  OTEL_SERVICE_NAME: z.string().default('truthshield-api'),
  OTEL_ENABLED: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(false),

  HUMAN_REVIEW_SCORE_MIN: z.coerce.number().default(40),
  HUMAN_REVIEW_SCORE_MAX: z.coerce.number().default(70),
  HUMAN_REVIEW_SLA_HOURS: z.coerce.number().default(24),
  HUMAN_REVIEW_NOTIFICATION_EMAIL: z.string().default(''),

  DATABASE_READ_URL: z.string().default(''),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(20),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().default(30000),
  DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().default(5000),
  SLOW_QUERY_THRESHOLD_MS: z.coerce.number().default(500),
  QUERY_LOG_ENABLED: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(false),

  DASHBOARD_CACHE_TTL: z.coerce.number().default(30),
  DASHBOARD_MAX_FEED_ITEMS: z.coerce.number().default(100),
  DASHBOARD_STATS_WINDOW_DAYS: z.coerce.number().default(30),

  PDF_REPORT_BUCKET: z.string().default('truthshield-reports'),
  PDF_GENERATION_TIMEOUT_MS: z.coerce.number().default(30000),
  REPORT_LOGO_S3_KEY: z.string().default('assets/logo.png'),
  PDF_WATERMARK_TEXT: z.string().default('CONFIDENTIAL'),

  WEBSOCKET_ENABLED: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(true),
  WEBSOCKET_CORS_ORIGIN: z.string().default(''),
  WEBSOCKET_HEARTBEAT_MS: z.coerce.number().default(25000),
  WEBSOCKET_TIMEOUT_MS: z.coerce.number().default(60000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;
