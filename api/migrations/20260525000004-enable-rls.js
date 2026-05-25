'use strict';

exports.up = function(db) {
  return db.runSql(`
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
  `);
};

exports.down = function(db) {
  return db.runSql(`
    ALTER TABLE users DISABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
  `);
};

exports._meta = {
  "version": 1
};
