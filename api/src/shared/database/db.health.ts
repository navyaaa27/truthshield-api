import { writePool, readPool, getSlowQueriesLastHourCount } from './pool.js';
import { env } from '../../config/env.js';

export interface DBHealthResult {
  writePool: {
    connected: boolean;
    poolSize: number;
    idleCount: number;
    waitingCount: number;
  };
  readPool: {
    connected: boolean;
    poolSize: number;
    idleCount: number;
    waitingCount: number;
  };
  replicationLag?: number;
  slowQueriesLastHour: number;
  longestRunningQuery?: {
    duration: number;
    state: string;
  };
}

export async function checkDatabaseHealth(): Promise<DBHealthResult> {
  if (process.env.MOCK_INFRA === 'true') {
    return {
      writePool: {
        connected: false,
        poolSize: 0,
        idleCount: 0,
        waitingCount: 0,
      },
      readPool: {
        connected: false,
        poolSize: 0,
        idleCount: 0,
        waitingCount: 0,
      },
      slowQueriesLastHour: 0,
    };
  }

  let writeConnected = false;
  try {
    const res = await writePool.query('SELECT 1');
    writeConnected = res.rowCount !== null;
  } catch (err) {
    writeConnected = false;
  }

  let readConnected = false;
  try {
    const res = await readPool.query('SELECT 1');
    readConnected = res.rowCount !== null;
  } catch (err) {
    readConnected = false;
  }

  // 1. Check replication lag (if DATABASE_READ_URL or read pool configured differently from write)
  let replicationLag: number | undefined;
  if (env.DATABASE_READ_URL) {
    try {
      const lagRes = await readPool.query(`
        SELECT EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp())) as lag
      `);
      if (lagRes.rows.length > 0 && lagRes.rows[0].lag !== null && lagRes.rows[0].lag !== undefined) {
        replicationLag = Number(lagRes.rows[0].lag);
      } else {
        replicationLag = 0;
      }
    } catch (err) {
      replicationLag = undefined;
    }
  }

  // 2. Check for long-running active queries
  let longestRunningQuery: { duration: number; state: string } | undefined;
  try {
    const longQueriesRes = await writePool.query(`
      SELECT EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) as duration, state 
      FROM pg_stat_activity 
      WHERE state != 'idle' 
        AND (clock_timestamp() - query_start) > interval '10 seconds'
      ORDER BY duration DESC
      LIMIT 1
    `);
    if (longQueriesRes.rows.length > 0) {
      longestRunningQuery = {
        duration: Number(longQueriesRes.rows[0].duration),
        state: String(longQueriesRes.rows[0].state),
      };
    }
  } catch (err) {
    longestRunningQuery = undefined;
  }

  const slowQueriesLastHour = getSlowQueriesLastHourCount();

  return {
    writePool: {
      connected: writeConnected,
      poolSize: writePool.totalCount,
      idleCount: writePool.idleCount,
      waitingCount: writePool.waitingCount,
    },
    readPool: {
      connected: readConnected,
      poolSize: readPool.totalCount,
      idleCount: readPool.idleCount,
      waitingCount: readPool.waitingCount,
    },
    replicationLag,
    slowQueriesLastHour,
    longestRunningQuery,
  };
}
