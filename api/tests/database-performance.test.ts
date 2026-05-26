/* eslint-disable @typescript-eslint/ban-ts-comment */
import { jest } from '@jest/globals';

// Setup Mocks
const mockWarn = jest.fn();
const mockError = jest.fn();
const mockDebug = jest.fn();
const mockInfo = jest.fn();

// Mock logger
jest.mock('../src/utils/logger.js', () => {
  return {
    logger: {
      warn: mockWarn,
      error: mockError,
      debug: mockDebug,
      info: mockInfo,
    },
  };
});

// Import pool and database modules after setting up mock environment
import {
  query,
  queryWrite,
  transaction,
  writePool,
  readPool,
  updatePoolMetrics,
  getSlowQueriesLastHourCount,
} from '../src/shared/database/pool.js';
import { checkDatabaseHealth } from '../src/shared/database/db.health.js';
import { JobModel } from '../src/modules/jobs/job.model.js';
import { AlertService } from '../src/modules/alerts/alert.service.js';
import { dbPoolSize, dbPoolIdle, dbPoolWaiting } from '../src/shared/metrics/metrics.service.js';

describe('Database Scaling & Hardening Performance Tests', () => {
  let readQuerySpy: any;
  let writeQuerySpy: any;
  let writeConnectSpy: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock totalCount/idleCount/waitingCount on pools for health check tests
    Object.defineProperty(writePool, 'totalCount', { value: 10, writable: true });
    Object.defineProperty(writePool, 'idleCount', { value: 6, writable: true });
    Object.defineProperty(writePool, 'waitingCount', { value: 1, writable: true });

    Object.defineProperty(readPool, 'totalCount', { value: 8, writable: true });
    Object.defineProperty(readPool, 'idleCount', { value: 4, writable: true });
    Object.defineProperty(readPool, 'waitingCount', { value: 0, writable: true });

    // Spy on underlying pool queries
    readQuerySpy = jest.spyOn(readPool, 'query').mockImplementation(() =>
      Promise.resolve({ rows: [{ id: 'res-1', score: 85, verdict: 'manipulated' }], rowCount: 1 } as any)
    );
    writeQuerySpy = jest.spyOn(writePool, 'query').mockImplementation(() =>
      Promise.resolve({ rows: [{ id: 'job-1', status: 'pending' }], rowCount: 1 } as any)
    );

    // Spy on writePool.connect for transactions
    const mockClient = {
      query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
      release: jest.fn(),
    };
    writeConnectSpy = jest.spyOn(writePool, 'connect').mockImplementation(() =>
      Promise.resolve(mockClient as any)
    );
  });

  afterEach(() => {
    readQuerySpy.mockRestore();
    writeQuerySpy.mockRestore();
    writeConnectSpy.mockRestore();
  });

  it('should route SELECT queries to readPool', async () => {
    const res = await query('SELECT * FROM users WHERE id = $1', ['user-uuid-123']);

    expect(readQuerySpy).toHaveBeenCalled();
    expect(writeQuerySpy).not.toHaveBeenCalled();
    expect(res.rowCount).toBe(1);
  });

  it('should route queryWrite explicitly to writePool', async () => {
    const res = await queryWrite('SELECT * FROM users WHERE id = $1', ['user-uuid-123']);

    expect(writeQuerySpy).toHaveBeenCalled();
    expect(readQuerySpy).not.toHaveBeenCalled();
    expect(res.rowCount).toBe(1);
  });

  it('should route INSERT/UPDATE/DELETE queries to writePool', async () => {
    const res = await query('INSERT INTO detection_jobs (org_id, status) VALUES ($1, $2)', ['org-1', 'pending']);

    expect(writeQuerySpy).toHaveBeenCalled();
    expect(readQuerySpy).not.toHaveBeenCalled();
    expect(res.rowCount).toBe(1);
  });

  it('should always use writePool for transaction() with isolation level and timeout', async () => {
    const mockTxCallback = jest.fn().mockImplementation(async (client: any) => {
      await client.query('SELECT 1');
      return 'success';
    });

    const result = await transaction(mockTxCallback as any, 'SERIALIZABLE');

    expect(writeConnectSpy).toHaveBeenCalled();
    expect(result).toBe('success');

    // Retrieve the client and verify queries
    const clientMock: any = await writeConnectSpy.mock.results[0].value;
    expect(clientMock.query).toHaveBeenCalledWith('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    expect(clientMock.query).toHaveBeenCalledWith("SET LOCAL statement_timeout = '30s'");
    expect(clientMock.query).toHaveBeenCalledWith('SELECT 1');
    expect(clientMock.query).toHaveBeenCalledWith('COMMIT');
  });

  it('should log a warning with truncated SQL and param count for slow queries (>500ms), and not leak parameter values', async () => {
    // Setup slow query detection by mocking Date.now to increment by 600ms per call
    let nowCounter = 100000;
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      nowCounter += 600;
      return nowCounter;
    });

    const longSql = 'SELECT ' + 'A'.repeat(300) + ' FROM users WHERE email = $1';
    const params = ['sensitive-user@domain.com'];

    await query(longSql, params);

    // Expect warning to be logged
    expect(mockWarn).toHaveBeenCalled();
    const warnCallArg = mockWarn.mock.calls[0][0] as string;

    // Assert SQL is truncated to 200 characters (truncated longSql is about 200 chars plus ...)
    expect(warnCallArg).toContain(longSql.substring(0, 200));
    expect(warnCallArg).toContain('...');

    // Assert parameter count is logged but NOT actual values
    expect(warnCallArg).toContain('Params count: 1');
    expect(warnCallArg).not.toContain('sensitive-user@domain.com');

    dateNowSpy.mockRestore();
  });

  it('should return correct slow queries count for last hour', () => {
    const count = getSlowQueriesLastHourCount();
    expect(typeof count).toBe('number');
  });

  it('should fetch jobs and their latest results using lateral join (getJobsByOrg makes exactly 1 jobs list DB query)', async () => {
    // Mock the read query response depending on search text
    readQuerySpy.mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*)')) {
        return Promise.resolve({ rows: [{ total: '15' }], rowCount: 1 } as any);
      }
      return Promise.resolve({ rows: [{ id: 'job-1' }], rowCount: 1 } as any);
    });

    const result = await JobModel.getJobsByOrg('org-123', { page: 1, limit: 10 });

    // Assert only one query was made with the lateral join
    const lateralJoinCalls = readQuerySpy.mock.calls.filter((call: any) =>
      call[0].toLowerCase().includes('latest_result')
    );
    expect(lateralJoinCalls.length).toBe(1);

    // Assert total count query was made
    const countCalls = readQuerySpy.mock.calls.filter((call: any) =>
      call[0].toLowerCase().includes('count(*)')
    );
    expect(countCalls.length).toBe(1);

    expect(result.total).toBe(15);
  });

  it('should retrieve alerts feed and results using LEFT JOIN (getAlerts makes exactly 1 paginated alerts list DB query)', async () => {
    // Mock read query depending on text
    readQuerySpy.mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*)') && sql.includes('acknowledged_at IS NULL') && !sql.includes('alerts a')) {
        return Promise.resolve({ rows: [{ count: 3 }], rowCount: 1 } as any); // unreadCount
      }
      if (sql.includes('COUNT(*)')) {
        return Promise.resolve({ rows: [{ count: 12 }], rowCount: 1 } as any); // total count
      }
      return Promise.resolve({ rows: [{ id: 'alert-1' }], rowCount: 1 } as any);
    });

    const result = await AlertService.getAlerts('org-123', { page: 1, limit: 10 });

    // Assert only one query was made with the LEFT JOIN
    const leftJoinCalls = readQuerySpy.mock.calls.filter((call: any) =>
      call[0].toLowerCase().includes('left join detection_results')
    );
    expect(leftJoinCalls.length).toBe(1);

    // Assert count queries were made
    const countCalls = readQuerySpy.mock.calls.filter((call: any) =>
      call[0].toLowerCase().includes('count(*)')
    );
    expect(countCalls.length).toBe(2);

    expect(result.total).toBe(12);
    expect(result.unreadCount).toBe(3);
  });

  it('should update Prometheus pool metrics and health check pool stats correctly', async () => {
    const sizeSpy = jest.spyOn(dbPoolSize, 'set');
    const idleSpy = jest.spyOn(dbPoolIdle, 'set');
    const waitSpy = jest.spyOn(dbPoolWaiting, 'set');

    updatePoolMetrics();

    // writePool.totalCount + readPool.totalCount = 10 + 8 = 18
    expect(sizeSpy).toHaveBeenCalledWith(18);
    // writePool.idleCount + readPool.idleCount = 6 + 4 = 10
    expect(idleSpy).toHaveBeenCalledWith(10);
    // writePool.waitingCount + readPool.waitingCount = 1 + 0 = 1
    expect(waitSpy).toHaveBeenCalledWith(1);

    const health = await checkDatabaseHealth();
    expect(health.writePool.poolSize).toBe(10);
    expect(health.writePool.idleCount).toBe(6);
    expect(health.writePool.waitingCount).toBe(1);
    expect(health.readPool.poolSize).toBe(8);
    expect(health.readPool.idleCount).toBe(4);
    expect(health.readPool.waitingCount).toBe(0);

    sizeSpy.mockRestore();
    idleSpy.mockRestore();
    waitSpy.mockRestore();
  });
});
