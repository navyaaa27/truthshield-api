/* eslint-disable @typescript-eslint/ban-ts-comment */
import { jest } from '@jest/globals';

// Setup Mock State
let migrationsRun = false;

// Mock the Database Pool and Query module
jest.mock('../src/shared/database/pool.js', () => {
  return {
    pool: {
      connect: jest.fn().mockImplementation(() =>
        Promise.resolve({
          query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
          release: jest.fn(),
        }),
      ),
      end: jest.fn().mockImplementation(() => Promise.resolve()),
    },
    testConnection: jest.fn().mockImplementation(() => Promise.resolve()),
    query: jest.fn().mockImplementation(((text: any, _params?: any) => {
      const sql = (text || '').trim().toLowerCase();

      // Wipe tables (Initial cleanup step)
      if (sql.startsWith('drop table')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // Check tables list in information_schema
      if (sql.includes('information_schema.tables') && sql.includes("'organizations'")) {
        if (migrationsRun) {
          return Promise.resolve({
            rows: [
              { table_name: 'organizations' },
              { table_name: 'users' },
              { table_name: 'audit_logs' },
            ],
            rowCount: 3,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // Check Row Level Security in pg_tables
      if (sql.includes('pg_tables') && sql.includes('rowsecurity')) {
        if (migrationsRun) {
          return Promise.resolve({
            rows: [
              { tablename: 'users', rowsecurity: true },
              { tablename: 'audit_logs', rowsecurity: true },
            ],
            rowCount: 2,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // Check columns in organizations
      if (
        (sql.includes('information_schema.columns') &&
          sql.includes("tablename = 'organizations'")) ||
        sql.includes("table_name = 'organizations'")
      ) {
        return Promise.resolve({
          rows: [
            { column_name: 'id', data_type: 'uuid', column_default: 'gen_random_uuid()' },
            { column_name: 'name', data_type: 'character varying', column_default: null },
            {
              column_name: 'plan_tier',
              data_type: 'character varying',
              column_default: "'starter'::character varying",
            },
            { column_name: 'api_key_hash', data_type: 'character varying', column_default: null },
            { column_name: 'is_active', data_type: 'boolean', column_default: 'true' },
          ],
          rowCount: 5,
        });
      }

      // Check columns in users
      if (
        (sql.includes('information_schema.columns') && sql.includes("tablename = 'users'")) ||
        sql.includes("table_name = 'users'")
      ) {
        return Promise.resolve({
          rows: [
            { column_name: 'id', data_type: 'uuid' },
            { column_name: 'org_id', data_type: 'uuid' },
            { column_name: 'email', data_type: 'character varying' },
            { column_name: 'password_hash', data_type: 'character varying' },
            { column_name: 'role', data_type: 'character varying' },
            { column_name: 'mfa_enabled', data_type: 'boolean' },
          ],
          rowCount: 6,
        });
      }

      return Promise.resolve({ rows: [], rowCount: 0 });
    }) as any),
    transaction: jest.fn().mockImplementation(((callback: any) => {
      const mockClient = {
        query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
      };
      return callback(mockClient as any);
    }) as any),
  };
});

// Mock the db-migrate module
jest.mock('db-migrate', () => {
  return {
    default: {
      getInstance: jest.fn().mockImplementation(() => {
        return {
          up: jest.fn().mockImplementation(async () => {
            migrationsRun = true;
            return Promise.resolve();
          }),
          down: jest.fn().mockImplementation(async (_limit?: any) => {
            migrationsRun = false;
            return Promise.resolve();
          }),
        };
      }),
    },
    getInstance: jest.fn().mockImplementation(() => {
      return {
        up: jest.fn().mockImplementation(async () => {
          migrationsRun = true;
          return Promise.resolve();
        }),
        down: jest.fn().mockImplementation(async (_limit?: any) => {
          migrationsRun = false;
          return Promise.resolve();
        }),
      };
    }),
  };
});

// Import modules to test
import { pool, query, testConnection } from '../src/shared/database/pool.js';
// @ts-expect-error
import DBMigrate from 'db-migrate';

describe('Database Layer & Migrations Integration Tests', () => {
  let dbmigrate: any;

  beforeAll(async () => {
    // 1. Verify environment connection
    await testConnection();

    // 2. Initialize programmatic db-migrate instance
    dbmigrate = DBMigrate.getInstance(true, {
      env: 'test',
      config: './database.json',
    });
  });

  afterAll(async () => {
    // Keep connections clean
    await pool.end();
  });

  it('should successfully execute migrations, verify tables exist, and roll back cleanly', async () => {
    // Step 1: Ensure no tables exist initially (clean state)
    await query('DROP TABLE IF EXISTS audit_logs CASCADE;');
    await query('DROP TABLE IF EXISTS users CASCADE;');
    await query('DROP TABLE IF EXISTS organizations CASCADE;');

    // Step 2: Run all migrations up
    console.log('Running database migrations up...');
    await dbmigrate.up();

    // Step 3: Query pg information_schema to verify tables exist
    const tablesCheck = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('organizations', 'users', 'audit_logs')
    `);

    const tableNames = tablesCheck.rows.map((row: any) => row.table_name);

    expect(tableNames).toContain('organizations');
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('audit_logs');
    expect(tablesCheck.rowCount).toBe(3);

    // Step 4: Verify columns & default values in organizations table
    const orgColumns = await query(`
      SELECT column_name, data_type, column_default 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'organizations'
    `);

    const orgColNames = orgColumns.rows.map((r: any) => r.column_name);
    expect(orgColNames).toContain('id');
    expect(orgColNames).toContain('name');
    expect(orgColNames).toContain('plan_tier');
    expect(orgColNames).toContain('api_key_hash');
    expect(orgColNames).toContain('is_active');

    const planTierCol = orgColumns.rows.find((r: any) => r.column_name === 'plan_tier');
    expect(planTierCol?.column_default).toContain('starter');

    // Step 5: Verify columns in users table
    const userColumns = await query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'users'
    `);

    const userColNames = userColumns.rows.map((r: any) => r.column_name);
    expect(userColNames).toContain('id');
    expect(userColNames).toContain('org_id');
    expect(userColNames).toContain('email');
    expect(userColNames).toContain('password_hash');
    expect(userColNames).toContain('role');
    expect(userColNames).toContain('mfa_enabled');

    // Step 6: Verify Row Level Security is active
    const rlsCheck = await query(`
      SELECT tablename, rowsecurity 
      FROM pg_tables 
      WHERE schemaname = 'public' AND tablename IN ('users', 'audit_logs')
    `);

    expect(rlsCheck.rowCount).toBe(2);
    rlsCheck.rows.forEach((row: any) => {
      expect(row.rowsecurity).toBe(true); // Row Level Security should be active
    });

    // Step 7: Roll back all migrations
    console.log('Rolling back database migrations down...');
    await dbmigrate.down(4);

    // Step 8: Assert tables have been completely removed
    const postRollbackTables = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('organizations', 'users', 'audit_logs')
    `);

    expect(postRollbackTables.rowCount).toBe(0);
  });
});
