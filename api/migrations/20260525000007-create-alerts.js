'use strict';

exports.up = function(db) {
  return db.runSql(`
    CREATE TABLE alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      result_id UUID NOT NULL REFERENCES detection_results(id),
      job_id UUID NOT NULL REFERENCES detection_jobs(id),
      severity VARCHAR(50) NOT NULL 
        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
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

    CREATE INDEX idx_alerts_org_unread 
      ON alerts(org_id, created_at DESC) 
      WHERE acknowledged_at IS NULL;
    CREATE INDEX idx_alerts_org_severity ON alerts(org_id, severity);
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP TABLE IF EXISTS alerts CASCADE;
  `);
};

exports._meta = {
  "version": 1
};
