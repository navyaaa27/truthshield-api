import { newDb } from 'pg-mem';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';

export function createMockPool() {
  const db = newDb();

  // Register uuid functions (impure: true ensures a fresh UUID on every row/call)
  db.public.registerFunction({
    name: 'gen_random_uuid',
    impure: true,
    implementation: () => randomUUID(),
  });
  db.public.registerFunction({
    name: 'uuid_generate_v4',
    impure: true,
    implementation: () => randomUUID(),
  });

  // Create all tables
  db.public.none(`
    CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      plan_tier VARCHAR(50) NOT NULL DEFAULT 'starter',
      api_key_hash VARCHAR(255),
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255),
      password_hash VARCHAR(255),
      role VARCHAR(50) NOT NULL DEFAULT 'admin',
      mfa_secret VARCHAR(255),
      mfa_enabled BOOLEAN DEFAULT false,
      two_factor_secret VARCHAR(255),
      is_two_factor_enabled BOOLEAN DEFAULT false,
      last_login TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID REFERENCES organizations(id),
      user_id UUID REFERENCES users(id),
      action VARCHAR(255) NOT NULL,
      resource_type VARCHAR(100),
      resource_id UUID,
      ip_address TEXT,
      user_agent TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS detection_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      created_by UUID REFERENCES users(id),
      content_type VARCHAR(50) NOT NULL,
      detection_modules TEXT[] NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 5,
      s3_key VARCHAR(1000),
      source_url TEXT,
      source_metadata JSONB DEFAULT '{}',
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      queued_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      aggregated_score NUMERIC(5,2),
      aggregated_verdict VARCHAR(50),
      aggregated_risk_level VARCHAR(20),
      modules_succeeded TEXT[] DEFAULT '{}',
      modules_failed TEXT[] DEFAULT '{}',
      modules_skipped TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS detection_results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID REFERENCES detection_jobs(id) ON DELETE CASCADE,
      org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      module VARCHAR(100) NOT NULL,
      score NUMERIC(5,2) NOT NULL,
      verdict VARCHAR(50) NOT NULL,
      confidence NUMERIC(5,2) NOT NULL,
      model_version VARCHAR(100) NOT NULL,
      processing_time_ms INTEGER,
      result_data JSONB NOT NULL DEFAULT '{}',
      flags TEXT[] DEFAULT '{}',
      reviewed_by UUID REFERENCES users(id),
      reviewed_at TIMESTAMPTZ,
      review_notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      result_id UUID,
      job_id UUID,
      severity VARCHAR(50) NOT NULL,
      title VARCHAR(500) NOT NULL,
      summary TEXT,
      acknowledged_by UUID REFERENCES users(id),
      acknowledged_at TIMESTAMPTZ,
      resolved_by UUID REFERENCES users(id),
      resolved_at TIMESTAMPTZ,
      notification_sent BOOLEAN DEFAULT false,
      notification_channels TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      created_by UUID REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      key_hash VARCHAR(255) NOT NULL,
      key_prefix VARCHAR(20) NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{}',
      allowed_ips TEXT[],
      rate_limit_override INTEGER,
      last_used_at TIMESTAMPTZ,
      last_used_ip TEXT,
      expires_at TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT true,
      revoked_at TIMESTAMPTZ,
      revoked_by UUID REFERENCES users(id) ON DELETE SET NULL,
      total_requests BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS brand_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      uploaded_by UUID REFERENCES users(id),
      asset_name VARCHAR(255) NOT NULL,
      asset_type VARCHAR(50) NOT NULL,
      s3_key VARCHAR(1000) NOT NULL,
      file_size_bytes BIGINT,
      mime_type VARCHAR(100),
      phash VARCHAR(64),
      phash_vector JSONB,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS human_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      result_id UUID,
      job_id UUID,
      org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      assigned_to UUID REFERENCES users(id),
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      priority VARCHAR(20) NOT NULL DEFAULT 'normal',
      ai_score NUMERIC(5,2) NOT NULL,
      ai_verdict VARCHAR(50) NOT NULL,
      reviewer_verdict VARCHAR(50),
      reviewer_notes TEXT,
      reviewer_confidence INTEGER,
      override_reason TEXT,
      sla_deadline TIMESTAMPTZ NOT NULL,
      assigned_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      requested_by UUID REFERENCES users(id) ON DELETE CASCADE,
      report_type VARCHAR(100) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'generating',
      date_range_start TIMESTAMPTZ NOT NULL,
      date_range_end TIMESTAMPTZ NOT NULL,
      s3_key VARCHAR(1000),
      file_size_bytes BIGINT,
      total_pages INTEGER,
      download_url TEXT,
      expires_at TIMESTAMPTZ,
      error_message TEXT,
      job_count INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      stripe_customer_id VARCHAR(255),
      stripe_subscription_id VARCHAR(255),
      plan_tier VARCHAR(50) NOT NULL DEFAULT 'starter',
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      current_period_start TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ,
      cancel_at_period_end BOOLEAN DEFAULT false,
      trial_end TIMESTAMPTZ,
      seats_included INTEGER DEFAULT 1,
      seats_used INTEGER DEFAULT 0,
      monthly_retainer_usd INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS usage_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      jobs_run INTEGER DEFAULT 0,
      jobs_limit INTEGER NOT NULL,
      uploads_count INTEGER DEFAULT 0,
      api_calls INTEGER DEFAULT 0,
      reports_generated INTEGER DEFAULT 0,
      overage_jobs INTEGER DEFAULT 0,
      overage_charged_usd INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS billing_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID REFERENCES organizations(id),
      stripe_event_id VARCHAR(255) NOT NULL,
      event_type VARCHAR(255) NOT NULL,
      processed BOOLEAN DEFAULT false,
      payload JSONB NOT NULL,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  logger.info('[MockDB] In-memory PostgreSQL database schema initialized successfully.');

  const pgAdapter = db.adapters.createPg();
  const pool = new pgAdapter.Pool();

  return pool;
}
