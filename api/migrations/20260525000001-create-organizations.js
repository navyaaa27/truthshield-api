'use strict';

exports.up = function(db) {
  return db.runSql(`
    CREATE TABLE organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      plan_tier VARCHAR(50) NOT NULL DEFAULT 'starter',
      api_key_hash VARCHAR(255) UNIQUE,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP TABLE IF EXISTS organizations CASCADE;
  `);
};

exports._meta = {
  "version": 1
};
