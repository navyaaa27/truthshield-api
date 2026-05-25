import pg from 'pg';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

const { Pool } = pg;

// Establish PostgreSQL pool with max 20 connections
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error(`Unexpected database pool error: ${err.message}`);
});

/**
 * On startup, test the connection and log success or throw a clear error.
 */
export async function testConnection(): Promise<void> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    logger.info('Database connection pool established and verified successfully.');
  } catch (error: any) {
    logger.error(`Database connection pool verification failed: ${error.message}`);
    throw new Error(`Database connection failed: ${error.message}`);
  }
}

/**
 * Wraps pool.query with error logging and slow query detection (>500ms).
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  try {
    const res = await pool.query<T>(text, params);
    const duration = Date.now() - start;

    // Log query executions. Warn if query is slow (>500ms)
    if (duration > 500) {
      logger.warn(`🐌 Slow database query detected (${duration}ms): ${text}`);
    } else {
      logger.debug(`Query executed: { duration: ${duration}ms, rows: ${res.rowCount} }`);
    }

    return res;
  } catch (error: any) {
    logger.error(`Database query failed: ${error.message} - Query: ${text}`);
    throw error;
  }
}

/**
 * Accepts a callback and handles BEGIN/COMMIT/ROLLBACK automatically.
 */
export async function transaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error: any) {
    logger.error(`Transaction block failed, rolling back: ${error.message}`);
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError: any) {
      logger.error(`ROLLBACK query execution failed: ${rollbackError.message}`);
    }
    throw error;
  } finally {
    client.release();
  }
}
