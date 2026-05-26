'use strict';

exports.up = function(db) {
  return db.runSql(`
    CREATE TABLE reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report_type VARCHAR(100) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'generating'
        CHECK (status IN (
          'generating', 'ready', 'failed', 'expired'
        )),
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

    CREATE INDEX idx_reports_org 
      ON reports(org_id, created_at DESC);
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP INDEX IF EXISTS idx_reports_org;
    DROP TABLE IF EXISTS reports;
  `);
};

exports._meta = {
  "version": 1
};
