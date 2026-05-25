import pg from 'pg';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.NODE_ENV === 'production' ? 20 : 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  logger.error(`Unexpected database error on idle client: ${err.message}`);
});

/**
 * Executes a PostgreSQL query with type-safety and automatic logging.
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  try {
    const res = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    logger.debug(`database query executed: { duration: ${duration}ms, rows: ${res.rowCount} }`);
    return res;
  } catch (error: any) {
    logger.error(`Database query failed: ${error.message} - Query: ${text}`);
    throw error;
  }
}

/**
 * Checks connection health.
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (error: any) {
    logger.error(`Database health check failed: ${error.message}`);
    return false;
  }
}
