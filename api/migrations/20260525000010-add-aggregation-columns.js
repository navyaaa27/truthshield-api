'use strict';

exports.up = function(db) {
  return db.runSql(`
    ALTER TABLE detection_jobs 
      ADD COLUMN IF NOT EXISTS aggregated_score NUMERIC(5,2),
      ADD COLUMN IF NOT EXISTS aggregated_verdict VARCHAR(50),
      ADD COLUMN IF NOT EXISTS aggregated_risk_level VARCHAR(20),
      ADD COLUMN IF NOT EXISTS modules_succeeded TEXT[] DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS modules_failed TEXT[] DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS modules_skipped TEXT[] DEFAULT '{}';

    CREATE INDEX IF NOT EXISTS idx_jobs_aggregated_risk 
      ON detection_jobs (org_id, aggregated_risk_level) 
      WHERE aggregated_risk_level IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_jobs_aggregated_verdict 
      ON detection_jobs (org_id, aggregated_verdict) 
      WHERE aggregated_verdict IS NOT NULL;
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP INDEX IF EXISTS idx_jobs_aggregated_verdict;
    DROP INDEX IF EXISTS idx_jobs_aggregated_risk;
    ALTER TABLE detection_jobs 
      DROP COLUMN IF EXISTS aggregated_score,
      DROP COLUMN IF EXISTS aggregated_verdict,
      DROP COLUMN IF EXISTS aggregated_risk_level,
      DROP COLUMN IF EXISTS modules_succeeded,
      DROP COLUMN IF EXISTS modules_failed,
      DROP COLUMN IF EXISTS modules_skipped;
  `);
};

exports._meta = {
  "version": 1
};
