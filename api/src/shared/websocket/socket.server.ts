import http from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { redisClient } from '../redis/redis.client.js';
import { verifyAccessToken } from '../../modules/auth/token.service.js';
import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
import { socketEmitter } from './socket.emitter.js';
import { query } from '../database/pool.js';

let io: Server | null = null;
let subClient: any = null;

// Helper function to validate if a job belongs to an organization
async function validateJobOwnership(jobId: string, orgId: string): Promise<boolean> {
  try {
    const res = await query('SELECT org_id FROM detection_jobs WHERE id = $1', [jobId]);
    if (res.rowCount === 0) return false;
    
    const dbOrgId = res.rows[0].org_id;
    return dbOrgId === orgId;
  } catch (err: any) {
    logger.error(`[WebSocket] Error validating job ownership for jobId ${jobId}: ${err.message}`);
    return false;
  }
}

export function initializeWebSocket(httpServer: http.Server): Server {
  if (!env.WEBSOCKET_ENABLED) {
    logger.warn('[WebSocket] Server is disabled by environment configurations.');
  }

  io = new Server(httpServer, {
    cors: {
      origin: env.WEBSOCKET_CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: env.WEBSOCKET_TIMEOUT_MS || 60000,
    pingInterval: env.WEBSOCKET_HEARTBEAT_MS || 25000,
    transports: ['websocket', 'polling'],
  });

  // Setup Redis Adapter for multi-instance horizontal scaling
  if (process.env.MOCK_INFRA !== 'true') {
    try {
      subClient = redisClient.duplicate();
      subClient.on('error', (err: any) => {
        logger.error(`[WebSocket] Redis subClient connection error: ${err.message}`);
      });
      io.adapter(createAdapter(redisClient, subClient));
      logger.info('[WebSocket] Redis adapter initialized successfully for horizontal scalability.');
    } catch (err: any) {
      logger.error(`[WebSocket] Failed to initialize Redis adapter: ${err.message}`);
    }
  } else {
    logger.warn('[WebSocket] MOCK_INFRA is enabled. Skipping Redis adapter setup.');
  }

  // Connection Authentication Middleware
  io.use(async (socket, next) => {
    try {
      let token = socket.handshake.auth?.token || socket.handshake.headers?.authorization;
      if (!token) {
        logger.warn('[WebSocket] Unauthorized connection attempt: missing token.');
        return next(new Error('Unauthorized'));
      }

      if (token.startsWith('Bearer ')) {
        token = token.substring(7).trim();
      }

      const payload = verifyAccessToken(token);
      socket.data.user = {
        userId: payload.userId,
        orgId: payload.orgId,
        role: payload.role,
      };

      next();
    } catch (err: any) {
      logger.warn(`[WebSocket] Unauthorized connection attempt: invalid token (${err.message})`);
      next(new Error('Unauthorized'));
    }
  });

  // Connection Event Handler
  io.on('connection', (socket: Socket) => {
    const { userId, orgId, role } = socket.data.user;

    // Join org room automatically
    socket.join(`org:${orgId}`);

    // Join user room
    socket.join(`user:${userId}`);

    logger.info('WebSocket connected', { userId, orgId, role, socketId: socket.id });

    // Send current unread alert count immediately
    socketEmitter.emitUnreadAlertCount(socket, orgId).catch((err) => {
      logger.error(`[WebSocket] Failed to send unread alert count: ${err.message}`);
    });

    // Handle room subscriptions for tracking job progress
    socket.on('subscribe:job', (jobId: string) => {
      validateJobOwnership(jobId, orgId)
        .then((valid) => {
          if (valid) {
            socket.join(`job:${jobId}`);
            logger.debug(`[WebSocket] Socket ${socket.id} joined room job:${jobId}`);
          } else {
            logger.warn(`[WebSocket] Unauthorized subscribe attempt to job:${jobId} by org:${orgId}`);
          }
        })
        .catch((err) => {
          logger.error(`[WebSocket] Error subscribing to job room: ${err.message}`);
        });
    });

    socket.on('unsubscribe:job', (jobId: string) => {
      socket.leave(`job:${jobId}`);
      logger.debug(`[WebSocket] Socket ${socket.id} left room job:${jobId}`);
    });

    // Heartbeat ping-pong for connectivity checks
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: Date.now() });
    });

    socket.on('disconnect', (reason) => {
      logger.info('WebSocket disconnected', { userId, reason, socketId: socket.id });
    });
  });

  return io;
}

export function getIO(): Server {
  if (!io) {
    throw new Error('Socket.io server has not been initialized');
  }
  return io;
}

export async function closeWebSocket(): Promise<void> {
  if (io) {
    await new Promise<void>((resolve) => {
      io!.close(() => {
        resolve();
      });
    });
    io = null;
  }
  if (subClient) {
    await subClient.quit().catch(() => {});
    subClient = null;
  }
}
