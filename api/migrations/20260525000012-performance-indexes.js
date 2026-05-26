'use strict';

exports.up = function(db) {
  return db.runSql(`
    CREATE INDEX idx_jobs_org_created_status 
      ON detection_jobs(org_id, created_at DESC, status)
      INCLUDE (content_type, aggregated_score, aggregated_verdict);

    CREATE INDEX idx_results_job_module 
      ON detection_results(job_id, module)
      INCLUDE (score, verdict, confidence, created_at);

    CREATE INDEX idx_alerts_org_created_severity 
      ON alerts(org_id, created_at DESC)
      INCLUDE (severity, acknowledged_at, title);

    CREATE INDEX idx_reviews_queue_order 
      ON human_reviews(status, priority DESC, sla_deadline ASC)
      INCLUDE (job_id, result_id, assigned_to)
      WHERE status IN ('pending', 'assigned', 'in_review');

    ANALYZE detection_jobs;
    ANALYZE detection_results;
    ANALYZE alerts;
    ANALYZE human_reviews;
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP INDEX IF EXISTS idx_jobs_org_created_status;
    DROP INDEX IF EXISTS idx_results_job_module;
    DROP INDEX IF EXISTS idx_alerts_org_created_severity;
    DROP INDEX IF EXISTS idx_reviews_queue_order;
  `);
};

exports._meta = {
  "version": 1
};
