'use strict';

exports.up = function(db) {
  return db.runSql(`
    CREATE TABLE detection_results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID NOT NULL REFERENCES detection_jobs(id) ON DELETE CASCADE,
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      module VARCHAR(100) NOT NULL
        CHECK (module IN ('deepfake', 'fake_news', 'stolen_content', 'metadata_tampering')),
      score NUMERIC(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
      verdict VARCHAR(50) NOT NULL
        CHECK (verdict IN ('clean', 'suspicious', 'manipulated', 'requires_review')),
      confidence NUMERIC(5,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
      model_version VARCHAR(100) NOT NULL,
      processing_time_ms INTEGER,
      result_data JSONB NOT NULL DEFAULT '{}',
      flags TEXT[] DEFAULT '{}',
      reviewed_by UUID REFERENCES users(id),
      reviewed_at TIMESTAMPTZ,
      review_notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX idx_results_job_id ON detection_results(job_id);
    CREATE INDEX idx_results_org_created ON detection_results(org_id, created_at DESC);
    CREATE INDEX idx_results_org_verdict ON detection_results(org_id, verdict)
      WHERE verdict IN ('suspicious', 'manipulated', 'requires_review');
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP TABLE IF EXISTS detection_results CASCADE;
  `);
};

exports._meta = {
  "version": 1
};
