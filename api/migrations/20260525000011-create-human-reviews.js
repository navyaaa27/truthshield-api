'use strict';

exports.up = function(db) {
  return db.runSql(`
    CREATE TABLE IF NOT EXISTS human_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      result_id UUID NOT NULL REFERENCES detection_results(id) ON DELETE CASCADE,
      job_id UUID NOT NULL REFERENCES detection_jobs(id) ON DELETE CASCADE,
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending'
        CHECK (status IN (
          'pending', 'assigned', 'in_review', 
          'completed', 'escalated', 'auto_resolved'
        )),
      priority VARCHAR(20) NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      ai_score NUMERIC(5,2) NOT NULL,
      ai_verdict VARCHAR(50) NOT NULL,
      reviewer_verdict VARCHAR(50)
        CHECK (reviewer_verdict IN (
          'clean', 'suspicious', 'manipulated', 
          'requires_escalation', 'inconclusive'
        )),
      reviewer_notes TEXT,
      reviewer_confidence INTEGER 
        CHECK (reviewer_confidence BETWEEN 1 AND 5),
      override_reason TEXT,
      sla_deadline TIMESTAMPTZ NOT NULL,
      assigned_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_reviews_status_priority 
      ON human_reviews(status, priority DESC, created_at ASC)
      WHERE status IN ('pending', 'assigned', 'in_review');
    CREATE INDEX IF NOT EXISTS idx_reviews_org 
      ON human_reviews(org_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reviews_assigned 
      ON human_reviews(assigned_to, status)
      WHERE assigned_to IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_reviews_sla 
      ON human_reviews(sla_deadline)
      WHERE status NOT IN ('completed', 'auto_resolved');
    
    ALTER TABLE human_reviews ENABLE ROW LEVEL SECURITY;
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP TABLE IF EXISTS human_reviews CASCADE;
  `);
};

exports._meta = {
  "version": 1
};
