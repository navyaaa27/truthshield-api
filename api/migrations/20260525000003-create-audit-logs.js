'use strict';

exports.up = function(db) {
  return db.runSql(`
    CREATE TABLE audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id),
      user_id UUID REFERENCES users(id),
      action VARCHAR(255) NOT NULL,
      resource_type VARCHAR(100),
      resource_id UUID,
      ip_address INET,
      user_agent TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_audit_logs_org_timestamp ON audit_logs(org_id, created_at DESC);
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP INDEX IF EXISTS idx_audit_logs_org_timestamp;
    DROP TABLE IF EXISTS audit_logs CASCADE;
  `);
};

exports._meta = {
  "version": 1
};
