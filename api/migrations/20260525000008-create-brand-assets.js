'use strict';

exports.up = function(db) {
  return db.runSql(`
    CREATE TABLE brand_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      uploaded_by UUID NOT NULL REFERENCES users(id),
      asset_name VARCHAR(255) NOT NULL,
      asset_type VARCHAR(50) NOT NULL
        CHECK (asset_type IN ('logo', 'image', 'video', 'document', 'other')),
      s3_key VARCHAR(1000) NOT NULL,
      file_size_bytes BIGINT,
      mime_type VARCHAR(100),
      phash VARCHAR(64),
      phash_vector JSONB,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX idx_brand_assets_org ON brand_assets(org_id) WHERE is_active = true;
    CREATE INDEX idx_brand_assets_phash ON brand_assets(org_id, phash);
  `);
};

exports.down = function(db) {
  return db.runSql(`
    DROP TABLE IF EXISTS brand_assets CASCADE;
  `);
};

exports._meta = {
  "version": 1
};
