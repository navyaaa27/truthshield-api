/* eslint-disable @typescript-eslint/ban-ts-comment */
process.env.ENABLE_SECURITY_MIDDLEWARE = 'false';
import http from 'http';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { env } from '../src/config/env.js';

// --- Mocks ---

// Mock Redis Client with duplicate and health functions
const mockSubClient = {
  on: jest.fn(),
  quit: jest.fn().mockImplementation(() => Promise.resolve()),
};

const mockRedisStore: Record<string, string> = {};

jest.mock('../src/shared/redis/redis.client.js', () => ({
  redisClient: {
    duplicate: jest.fn().mockReturnValue(mockSubClient),
    get: jest
      .fn()
      .mockImplementation(((key: any) => Promise.resolve(mockRedisStore[key] || null)) as any),
    setex: jest.fn().mockImplementation(((key: any, _ttl: any, val: any) => {
      mockRedisStore[key] = val;
      return Promise.resolve('OK');
    }) as any),
    del: jest.fn().mockImplementation(((key: any) => {
      delete mockRedisStore[key];
      return Promise.resolve(1);
    }) as any),
    keys: jest.fn().mockImplementation((() => Promise.resolve(Object.keys(mockRedisStore))) as any),
    incr: jest.fn().mockImplementation((() => Promise.resolve(1)) as any),
    expire: jest.fn().mockImplementation((() => Promise.resolve(1)) as any),
    call: jest.fn().mockImplementation(((command: string, ...args: any[]) => {
      const cmd = command.toLowerCase();
      if (cmd === 'script' && args[0]?.toLowerCase() === 'load') {
        return Promise.resolve('fake_sha_hash');
      }
      if (cmd === 'evalsha' || cmd === 'eval') {
        const key =
          args.find(
            (arg) =>
              typeof arg === 'string' && (arg.startsWith('ts:rl:') || arg.startsWith('ts:sd:')),
          ) || 'unknown_key';
        const val = parseInt(mockRedisStore[key] || '0', 10) + 1;
        mockRedisStore[key] = val.toString();
        return Promise.resolve([val, 60]);
      }
      return Promise.resolve();
    }) as any),
    on: jest.fn(),
    ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
  },
  isRedisHealthy: jest.fn().mockImplementation(() => Promise.resolve(true)),
  getRedisLatency: jest.fn().mockImplementation(() => Promise.resolve(5)),
}));

// Mock Redis Service index
jest.mock('../src/shared/redis/index.js', () => ({
  checkRedisHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
  redis: {
    ping: jest.fn().mockImplementation(() => Promise.resolve('PONG')),
    quit: jest.fn().mockImplementation(() => Promise.resolve()),
  },
}));

// Mock Database Queries
let mockAlertCount = 3;
const mockJobsDb: Record<string, string> = {
  'job-123': 'org-uuid-1',
  'job-abc': 'org-uuid-1',
  'job-other-org': 'org-uuid-999',
};

jest.mock('../src/shared/database/pool.js', () => ({
  pool: {
    connect: jest.fn().mockImplementation(() =>
      Promise.resolve({
        query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
        release: jest.fn(),
      }),
    ),
    end: jest.fn().mockImplementation(() => Promise.resolve()),
  },
  query: jest.fn().mockImplementation(((text: string, params?: any[]) => {
    const sql = (text || '').trim().toLowerCase();
    const p = params || [];

    // SELECT org_id FROM detection_jobs WHERE id = $1
    if (sql.includes('select org_id from detection_jobs')) {
      const jobId = p[0];
      const orgId = mockJobsDb[jobId];
      if (orgId) {
        return Promise.resolve({ rows: [{ org_id: orgId }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }

    // SELECT COUNT(*)::int as count FROM alerts
    if (sql.includes('count(*)::int as count from alerts')) {
      return Promise.resolve({ rows: [{ count: mockAlertCount }], rowCount: 1 });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  }) as any),
}));

// Mock database/index.js health checks to prevent real connection pools hanging on health requests
jest.mock('../src/shared/database/index.js', () => ({
  pool: {
    connect: jest.fn().mockImplementation(() =>
      Promise.resolve({
        query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
        release: jest.fn(),
      }),
    ),
    end: jest.fn().mockImplementation(() => Promise.resolve()),
  },
  checkDatabaseHealth: (jest.fn() as any).mockResolvedValue({
    status: 'healthy',
    writePool: { connected: true, activeConnections: 1, idleConnections: 1, totalConnections: 2 },
    readPool: { connected: true, activeConnections: 1, idleConnections: 1, totalConnections: 2 },
  }),
}));

// Mock Queue service to prevent BullMQ hanging on health checks
jest.mock('../src/shared/queue/queues.js', () => ({
  detectionQueue: {
    getJobCounts: (jest.fn() as any).mockResolvedValue({ waiting: 0 }),
    add: (jest.fn() as any).mockResolvedValue({}),
  },
  alertQueue: {
    getJobCounts: (jest.fn() as any).mockResolvedValue({ waiting: 0 }),
    add: (jest.fn() as any).mockResolvedValue({}),
  },
  cleanupQueue: {
    getJobCounts: (jest.fn() as any).mockResolvedValue({ waiting: 0 }),
  },
  reportQueue: {
    getJobCounts: (jest.fn() as any).mockResolvedValue({ waiting: 0 }),
  },
}));

// Load express app
import { app } from '../src/app.js';
import {
  initializeWebSocket,
  closeWebSocket,
  getIO,
} from '../src/shared/websocket/socket.server.js';
import { socketEmitter } from '../src/shared/websocket/socket.emitter.js';

function signToken(userId: string, role: string, orgId: string) {
  return jwt.sign({ userId, role, orgId }, env.JWT_SECRET || 'test-secret', { expiresIn: '15m' });
}

describe('WebSocket Server Real-time Alert & Progress Suite', () => {
  let server: http.Server;
  let port: number;
  let socketUrl: string;
  let openClients: ClientSocket[] = [];

  beforeAll((done) => {
    // Enable WebSockets in test config
    env.WEBSOCKET_ENABLED = true;

    server = http.createServer(app);
    initializeWebSocket(server);

    server.listen(0, () => {
      const address = server.address();
      port = (address as any).port;
      socketUrl = `http://localhost:${port}`;
      done();
    });
  });

  afterAll(async () => {
    // Disconnect any lingering socket clients
    for (const client of openClients) {
      client.disconnect();
      client.close();
    }
    openClients = [];

    // Force close server-side sockets
    try {
      const io = getIO();
      io.disconnectSockets(true);
      io.close();
    } catch {
      // Ignored
    }

    // Close WebSocket server and subClient
    await closeWebSocket();

    // Close HTTP Server
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function createTestSocketClient(token?: string): ClientSocket {
    const client = ioClient(socketUrl, {
      auth: token ? { token } : undefined,
      transports: ['websocket'],
      forceNew: true,
    });
    openClients.push(client);
    return client;
  }

  it('should reject unauthenticated connections with an Unauthorized error', (done) => {
    const client = createTestSocketClient();

    client.on('connect_error', (err) => {
      expect(err.message).toBe('Unauthorized');
      client.disconnect();
      done();
    });
  });

  it('should establish connection for client with a valid authorization token', (done) => {
    const token = signToken('user-1', 'admin', 'org-uuid-1');
    const client = createTestSocketClient(token);

    client.on('connect', () => {
      expect(client.connected).toBe(true);
      client.disconnect();
      done();
    });
  });

  it('should send current unread alert count immediately upon successful connection', (done) => {
    mockAlertCount = 8;
    const token = signToken('user-1', 'admin', 'org-uuid-1');
    const client = createTestSocketClient(token);

    client.on('alerts:unread_count', (payload) => {
      expect(payload).toBeDefined();
      expect(payload.count).toBe(8);
      client.disconnect();
      done();
    });
  });

  it('should automatically join org:{orgId} room and receive job updates emitted by org', (done) => {
    const token1 = signToken('user-1', 'admin', 'org-uuid-1');
    const token2 = signToken('user-2', 'analyst', 'org-uuid-2'); // Different org

    const client1 = createTestSocketClient(token1);
    const client2 = createTestSocketClient(token2);

    let client1Connected = false;
    let client2Connected = false;

    const proceed = () => {
      if (client1Connected && client2Connected) {
        // Emit update specifically for org-uuid-1
        socketEmitter.emitJobUpdate('org-uuid-1', 'job-123', {
          status: 'processing',
          progress: 50,
          completedModules: ['deepfake'],
        });
      }
    };

    client1.on('connect', () => {
      client1Connected = true;
      proceed();
    });

    client2.on('connect', () => {
      client2Connected = true;
      proceed();
    });

    client1.on('job:update', (payload) => {
      expect(payload.jobId).toBe('job-123');
      expect(payload.status).toBe('processing');
      expect(payload.progress).toBe(50);
      expect(payload.completedModules).toContain('deepfake');

      // Ensure client2 did NOT receive it
      client1.disconnect();
      client2.disconnect();
      done();
    });

    client2.on('job:update', () => {
      fail('Client 2 should not receive job updates for Org 1');
    });
  });

  it('should emit job progress events in order (0 -> 50 -> 100) and verify receipt', (done) => {
    const token = signToken('user-1', 'admin', 'org-uuid-1');
    const client = createTestSocketClient(token);

    const receivedProgresses: number[] = [];

    client.on('connect', () => {
      // Emit 0%
      socketEmitter.emitJobUpdate('org-uuid-1', 'job-123', {
        status: 'processing',
        progress: 0,
      });

      // Emit 50%
      socketEmitter.emitJobUpdate('org-uuid-1', 'job-123', {
        status: 'processing',
        progress: 50,
      });

      // Emit 100%
      socketEmitter.emitJobUpdate('org-uuid-1', 'job-123', {
        status: 'completed',
        progress: 100,
        aggregatedScore: 88,
        aggregatedVerdict: 'manipulated',
      });
    });

    client.on('job:update', (payload) => {
      receivedProgresses.push(payload.progress);

      if (receivedProgresses.length === 3) {
        expect(receivedProgresses).toEqual([0, 50, 100]);
        expect(payload.aggregatedScore).toBe(88);
        expect(payload.aggregatedVerdict).toBe('manipulated');
        client.disconnect();
        done();
      }
    });
  });

  it('should receive new alerts via org room subscription', (done) => {
    const token = signToken('user-1', 'admin', 'org-uuid-1');
    const client = createTestSocketClient(token);

    client.on('connect', () => {
      socketEmitter.emitNewAlert('org-uuid-1', {
        id: 'alert-abc',
        severity: 'critical',
        title: 'Deepfake face swap detected',
        job_id: 'job-123',
        module: 'deepfake',
        score: 95,
      });
    });

    client.on('alert:new', (payload) => {
      expect(payload.alertId).toBe('alert-abc');
      expect(payload.severity).toBe('critical');
      expect(payload.title).toBe('Deepfake face swap detected');
      expect(payload.jobId).toBe('job-123');
      expect(payload.module).toBe('deepfake');
      expect(payload.score).toBe(95);

      client.disconnect();
      done();
    });
  });

  it('should deliver human review assignments only to the target user room', (done) => {
    const tokenTarget = signToken('analyst-target', 'analyst', 'org-uuid-1');
    const tokenOther = signToken('analyst-other', 'analyst', 'org-uuid-1'); // Same org, different user

    const clientTarget = createTestSocketClient(tokenTarget);
    const clientOther = createTestSocketClient(tokenOther);

    let targetConnected = false;
    let otherConnected = false;

    const proceed = () => {
      if (targetConnected && otherConnected) {
        socketEmitter.emitReviewAssigned('analyst-target', {
          id: 'review-999',
          job_id: 'job-abc',
          priority: 'high',
          sla_deadline: new Date(Date.now() + 8 * 3600 * 1000),
        });
      }
    };

    clientTarget.on('connect', () => {
      targetConnected = true;
      proceed();
    });

    clientOther.on('connect', () => {
      otherConnected = true;
      proceed();
    });

    clientTarget.on('review:assigned', (payload) => {
      expect(payload.reviewId).toBe('review-999');
      expect(payload.jobId).toBe('job-abc');
      expect(payload.priority).toBe('high');
      expect(payload.slaDeadline).toBeDefined();

      clientTarget.disconnect();
      clientOther.disconnect();
      done();
    });

    clientOther.on('review:assigned', () => {
      fail('Other analyst should not receive assignment events of target analyst');
    });
  });

  it('should join and leave job rooms dynamically on demand with job ownership validation', (done) => {
    const token = signToken('user-1', 'admin', 'org-uuid-1');
    const client = createTestSocketClient(token);

    client.on('connect', () => {
      // Subscribe to authorized job
      client.emit('subscribe:job', 'job-abc');

      // Subscribe to unauthorized job (belongs to org-uuid-999)
      client.emit('subscribe:job', 'job-other-org');

      setTimeout(() => {
        // Now emit job updates and verify client only gets updates for job-abc
        const io = getIO();
        io.to('job:job-abc').emit('job:update', { jobId: 'job-abc', progress: 80 });
        io.to('job:job-other-org').emit('job:update', { jobId: 'job-other-org', progress: 90 });
      }, 100);
    });

    client.on('job:update', (payload) => {
      expect(payload.jobId).toBe('job-abc');
      expect(payload.progress).toBe(80);

      // Now unsubscribe
      client.emit('unsubscribe:job', 'job-abc');

      setTimeout(() => {
        const io = getIO();
        io.to('job:job-abc').emit('job:update', { jobId: 'job-abc', progress: 100 });
        setTimeout(() => {
          client.disconnect();
          done();
        }, 100);
      }, 100);
    });
  });

  it('should respond to ping with a pong containing timestamp', (done) => {
    const token = signToken('user-1', 'admin', 'org-uuid-1');
    const client = createTestSocketClient(token);

    client.on('connect', () => {
      client.emit('ping');
    });

    client.on('pong', (payload) => {
      expect(payload.timestamp).toBeDefined();
      expect(payload.timestamp).toBeLessThanOrEqual(Date.now());
      client.disconnect();
      done();
    });
  });

  it('should report websocket stats under health check endpoint correctly', async () => {
    const token = signToken('user-1', 'admin', 'org-uuid-1');
    const client = createTestSocketClient(token);

    await new Promise<void>((resolve) => {
      client.on('connect', () => resolve());
    });

    const supertest = (await import('supertest')).default;
    const res = await supertest(server).get('/health').expect(200);

    expect(res.body.websocket).toBeDefined();
    expect(res.body.websocket.enabled).toBe(true);
    expect(res.body.websocket.connectedClients).toBeGreaterThanOrEqual(1);
    expect(res.body.websocket.rooms).toBeGreaterThanOrEqual(3); // default connection rooms + org:org-uuid-1 + user:user-1

    client.disconnect();
  });
});
