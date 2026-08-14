import pg from 'pg';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import {
  dbPoolIdle,
  dbPoolSize,
  dbPoolWaiting,
  dbQueryDurationMs,
} from '../metrics/metrics.service.js';

const { Pool } = pg;

// Connection configurations
const poolConfig = {
  min: env.DATABASE_POOL_MIN,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: env.DATABASE_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
};

// 1. Establish primary write pool
export const writePool = new Pool({
  connectionString: env.DATABASE_URL,
  ...poolConfig,
  application_name: 'truthshield-api-write',
});

// 2. Establish read replica pool
export const readPool = new Pool({
  connectionString: env.DATABASE_READ_URL || env.DATABASE_URL,
  ...poolConfig,
  application_name: 'truthshield-api-read',
});

// Error handling for both pools
writePool.on('error', (err) => {
  logger.error(`Unexpected database writePool error: ${err.message}`);
});

readPool.on('error', (err) => {
  logger.error(`Unexpected database readPool error: ${err.message}`);
});

// Track slow queries timestamps in rolling window
let slowQueriesTimestamps: number[] = [];

export function recordSlowQuery(): void {
  slowQueriesTimestamps.push(Date.now());
}

export function getSlowQueriesLastHourCount(): number {
  const oneHourAgo = Date.now() - 3600000;
  slowQueriesTimestamps = slowQueriesTimestamps.filter((t) => t >= oneHourAgo);
  return slowQueriesTimestamps.length;
}

// Helper to get stack trace (first 3 frames)
function getStackTrace(): string {
  const stack = new Error().stack || '';
  const lines = stack.split('\n');
  // Skip first 2 lines: the Error message and current frame
  return lines.slice(2, 5).join('\n');
}

// Update Prometheus metrics for pool sizes
export function updatePoolMetrics(): void {
  const writePoolSize = writePool.totalCount;
  const writePoolIdle = writePool.idleCount;
  const writePoolWait = writePool.waitingCount;

  const readPoolSize = readPool.totalCount;
  const readPoolIdle = readPool.idleCount;
  const readPoolWait = readPool.waitingCount;

  dbPoolSize.set(writePoolSize + readPoolSize);
  dbPoolIdle.set(writePoolIdle + readPoolIdle);
  dbPoolWaiting.set(writePoolWait + readPoolWait);
}

/**
 * On startup, test both pools and log success.
 */
export async function testConnection(): Promise<void> {
  try {
    const writeClient = await writePool.connect();
    await writeClient.query('SELECT 1');
    writeClient.release();

    const readClient = await readPool.connect();
    await readClient.query('SELECT 1');
    readClient.release();

    updatePoolMetrics();
    logger.info('Database production-grade connection pools verified successfully.');
  } catch (error: any) {
    logger.error(`Database pools verification failed: ${error.message}`);
    throw new Error(`Database connection failed: ${error.message}`);
  }
}

/**
 * Query executor with Prometheus metrics, slow-query warnings, and logging.
 */
export async function queryWithMetrics<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[],
  context?: { module?: string; operation?: string },
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const sqlVerb = sql.trimStart().split(/\s+/)[0]?.toUpperCase() || 'UNKNOWN';
  const operation = context?.operation || sqlVerb;
  const moduleName = context?.module || 'database';

  // Determine target pool based on SQL keyword or route SELECT queries to read pool
  const isSelect = sql.trimStart().toUpperCase().startsWith('SELECT');
  const targetPool = isSelect ? readPool : writePool;

  try {
    let res;
    try {
      res = await targetPool.query<T>(sql, params);
    } catch (readErr: any) {
      if (targetPool === readPool) {
        logger.warn(`Read replica query failed, falling back to writePool: ${readErr.message}`);
        res = await writePool.query<T>(sql, params);
      } else {
        throw readErr;
      }
    }

    const duration = Date.now() - start;

    // Record metrics
    dbQueryDurationMs.observe({ operation, module: moduleName }, duration);
    updatePoolMetrics();

    // Debug logging in development only
    if (env.QUERY_LOG_ENABLED && env.NODE_ENV === 'development') {
      logger.debug(
        `[DB Query] Duration: ${duration}ms | SQL: ${sql} | Params: ${JSON.stringify(params)}`,
      );
    }

    // Slow query detection
    if (duration > env.SLOW_QUERY_THRESHOLD_MS) {
      recordSlowQuery();
      const truncatedSql = sql.length > 200 ? `${sql.substring(0, 200)}...` : sql;
      const paramsCount = params ? params.length : 0;
      const stackTrace = getStackTrace();

      logger.warn(
        `🐌 Slow database query detected (${duration}ms) | SQL: "${truncatedSql}" | Params count: ${paramsCount} | Context: ${JSON.stringify(
          context || {},
        )} | Stack Trace:\n${stackTrace}`,
      );
    }

    return res;
  } catch (error: any) {
    logger.error(`Database query failed: ${error.message} - Query: ${sql}`);
    throw error;
  }
}

/**
 * Default smart-routed query helper.
 */
export async function query<T extends pg.QueryResultRow = any>(
  sql: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  return queryWithMetrics<T>(sql, params || []);
}

/**
 * Force query execution to use primary write pool (read-your-writes consistency).
 */
export async function queryWrite<T extends pg.QueryResultRow = any>(
  sql: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const sqlVerb = sql.trimStart().split(/\s+/)[0]?.toUpperCase() || 'UNKNOWN';

  try {
    const res = await writePool.query<T>(sql, params || []);
    const duration = Date.now() - start;

    dbQueryDurationMs.observe({ operation: sqlVerb, module: 'database-write' }, duration);
    updatePoolMetrics();

    if (duration > env.SLOW_QUERY_THRESHOLD_MS) {
      recordSlowQuery();
      const truncatedSql = sql.length > 200 ? `${sql.substring(0, 200)}...` : sql;
      const paramsCount = params ? params.length : 0;
      logger.warn(
        `🐌 Slow database writePool query detected (${duration}ms) | SQL: "${truncatedSql}" | Params count: ${paramsCount}`,
      );
    }

    return res;
  } catch (error: any) {
    logger.error(`Database queryWrite failed: ${error.message} - Query: ${sql}`);
    throw error;
  }
}

/**
 * Backwards compatibility export of default pool.
 */
export const pool = writePool;

/**
 * Transaction runner executing on primary writePool with statement timeout and customizable isolation level.
 */
export async function transaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>,
  isolationLevel: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'READ COMMITTED',
): Promise<T> {
  const client = await writePool.connect();
  try {
    await client.query(`BEGIN TRANSACTION ISOLATION LEVEL ${isolationLevel}`);
    await client.query(`SET LOCAL statement_timeout = '30s'`);
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
    updatePoolMetrics();
  }
}
