'use strict';

exports.up = function(db) {
  return db.runSql(`
    CREATE TABLE subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL UNIQUE 
        REFERENCES organizations(id) ON DELETE CASCADE,
      stripe_customer_id VARCHAR(255) UNIQUE,
      stripe_subscription_id VARCHAR(255) UNIQUE,
      plan_tier VARCHAR(50) NOT NULL DEFAULT 'starter',
      status VARCHAR(50) NOT NULL DEFAULT 'active'
        CHECK (status IN (
          'active', 'past_due', 'canceled', 
          'trialing', 'incomplete', 'paused'
        )),
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

    CREATE TABLE usage_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
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

    CREATE INDEX idx_usage_org_period 
      ON usage_records(org_id, period_start DESC);

    CREATE TABLE billing_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
      stripe_event_id VARCHAR(255) UNIQUE NOT NULL,
      event_type VARCHAR(255) NOT NULL,
      processed BOOLEAN DEFAULT false,
      payload JSONB NOT NULL,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP TABLE IF EXISTS billing_events;
    DROP INDEX IF EXISTS idx_usage_org_period;
    DROP TABLE IF EXISTS usage_records;
    DROP TABLE IF EXISTS subscriptions;
  `);
};

exports._meta = {
  "version": 1
};
