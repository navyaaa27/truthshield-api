'use strict';

exports.up = function(db) {
  return db.runSql(`
    CREATE TABLE api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      key_hash VARCHAR(255) NOT NULL UNIQUE,
      key_prefix VARCHAR(20) NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{}',
      allowed_ips INET[],
      rate_limit_override INTEGER,
      last_used_at TIMESTAMPTZ,
      last_used_ip INET,
      expires_at TIMESTAMPTZ,
      is_active BOOLEAN DEFAULT true,
      revoked_at TIMESTAMPTZ,
      revoked_by UUID REFERENCES users(id) ON DELETE SET NULL,
      total_requests BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX idx_api_keys_org 
      ON api_keys(org_id) WHERE is_active = true;
    CREATE INDEX idx_api_keys_hash 
      ON api_keys(key_hash) WHERE is_active = true;
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP INDEX IF EXISTS idx_api_keys_hash;
    DROP INDEX IF EXISTS idx_api_keys_org;
    DROP TABLE IF EXISTS api_keys;
  `);
};

exports._meta = {
  "version": 1
};
