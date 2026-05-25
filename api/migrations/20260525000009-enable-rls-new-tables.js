'use strict';

exports.up = function(db) {
  return db.runSql(`
    ALTER TABLE detection_jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE detection_results ENABLE ROW LEVEL SECURITY;
    ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE brand_assets ENABLE ROW LEVEL SECURITY;
  `);
};

exports.down = function(db) {
  return db.runSql(`
    ALTER TABLE detection_jobs DISABLE ROW LEVEL SECURITY;
    ALTER TABLE detection_results DISABLE ROW LEVEL SECURITY;
    ALTER TABLE alerts DISABLE ROW LEVEL SECURITY;
    ALTER TABLE brand_assets DISABLE ROW LEVEL SECURITY;
  `);
};

exports._meta = {
  "version": 1
};
