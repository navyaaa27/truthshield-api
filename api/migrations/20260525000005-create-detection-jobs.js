'use strict';

exports.up = function(db) {
  return db.runSql(`
    CREATE TABLE detection_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      created_by UUID NOT NULL REFERENCES users(id),
      content_type VARCHAR(50) NOT NULL 
        CHECK (content_type IN ('video', 'image', 'article', 'url', 'file')),
      detection_modules TEXT[] NOT NULL 
        CHECK (array_length(detection_modules, 1) > 0),
      status VARCHAR(50) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'cancelled')),
      priority INTEGER NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
      s3_key VARCHAR(1000),
      source_url TEXT,
      source_metadata JSONB DEFAULT '{}',
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      queued_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX idx_jobs_org_status ON detection_jobs(org_id, status);
    CREATE INDEX idx_jobs_org_created ON detection_jobs(org_id, created_at DESC);
    CREATE INDEX idx_jobs_status_priority ON detection_jobs(status, priority DESC, created_at ASC)
      WHERE status IN ('pending', 'queued');
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP TABLE IF EXISTS detection_jobs CASCADE;
  `);
};

exports._meta = {
  "version": 1
};
