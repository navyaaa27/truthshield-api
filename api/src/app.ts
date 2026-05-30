import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import hpp from 'hpp';
import mongoSanitize from 'express-mongo-sanitize';
import morgan from 'morgan';
import { errorHandler, NotFoundError } from './middleware/error.js';
import { logger, createRequestLogger } from './utils/logger.js';
import { env } from './config/env.js';
import authRoutes from './modules/auth/auth.routes.js';
import { metricsMiddleware } from './middleware/metrics.middleware.js';
import { requestLogger } from './middleware/requestLogger.js';
import { register } from './shared/metrics/metrics.service.js';
import orgRoutes from './modules/organizations/organization.routes.js';
import userRoutes from './modules/users/users.routes.js';
import uploadRoutes from './modules/uploads/upload.routes.js';
import jobRoutes from './modules/jobs/job.routes.js';
import alertRoutes from './modules/alerts/alert.routes.js';
import reviewRoutes from './modules/review/review.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import reportRoutes from './modules/reports/report.routes.js';
import apikeyRoutes from './modules/api-keys/apikey.routes.js';
import clientApiRoutes from './modules/client-api/client.routes.js';
import billingRoutes from './modules/billing/billing.routes.js';
import { webhookRouter } from './modules/billing/stripe.webhook.js';
import { checkDatabaseHealth } from './shared/database/index.js';
import { checkRedisHealth } from './shared/redis/index.js';
import { getIO } from './shared/websocket/socket.server.js';
import { createBullBoard } from '@bull-board/api';
// @ts-ignore
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { detectionQueue, alertQueue, cleanupQueue, reportQueue } from './shared/queue/queues.js';

const app = express();
app.set('trust proxy', 1);

// 1. Trace log initialization (injects X-Request-ID and tracks incoming headers)
app.use(createRequestLogger());
app.use(metricsMiddleware);
app.use(requestLogger);

// 2. Hardened Security Headers with Helmet
app.use(
  helmet({
    contentSecurityPolicy: true,
    hsts: { maxAge: 31536000, includeSubDomains: true },
    frameguard: { action: 'deny' },
  })
);

// 3. Hardened Cross-Origin Resource Sharing (CORS)
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : true,
    credentials: true,
  })
);

// 4. Parameter Pollution and Query Injection Sanitizers
app.use(hpp());
app.use(mongoSanitize());

// Stripe Webhook mounted before JSON parsing to preserve raw request body
app.use('/webhooks', webhookRouter);

// 5. Hardened request body parsing limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// 6. Request Validation
import { validateContentType, validateRequestSize, sanitizeInput, validateOrigin } from './middleware/requestValidation.js';
app.use(validateContentType);
app.use(validateRequestSize);
app.use(sanitizeInput);
app.use(validateOrigin);

// 7. Rate Limiting & Abuse Prevention
import { globalLimiter } from './middleware/rateLimiter.js';
import { abuseCheck } from './middleware/abuseDetection.js';
app.use(globalLimiter);
app.use(abuseCheck);

// Morgan logger setup for HTTP performance
const morganStream = {
  write: (message: string) => {
    logger.debug(message.trim());
  },
};
app.use(
  morgan(':remote-addr :method :url :status :res[content-length] - :response-time ms', {
    stream: morganStream,
  })
);

// 6. Hardened Health Check Endpoint
app.get('/health', async (_req, res) => {
  if (process.env.MOCK_INFRA === 'true') {
    res.status(200).json({
      status: 'ok',
      mode: 'mock_preview',
      database: {
        writePool: { connected: false },
        readPool: { connected: false },
      },
      redis: { connected: false },
    });
    return;
  }

  const dbHealth = await checkDatabaseHealth();
  const redisHealthy = await checkRedisHealth();

  // Measure Redis latency
  let redisLatencyMs = -1;
  try {
    const start = Date.now();
    await import('./shared/redis/redis.client.js').then((m) => m.redisClient.ping());
    redisLatencyMs = Date.now() - start;
  } catch {
    redisLatencyMs = -1;
  }

  // Get queue depths
  let detectionQueueDepth = 0;
  let alertQueueDepth = 0;
  try {
    const detCounts = await detectionQueue.getJobCounts();
    const alertCounts = await alertQueue.getJobCounts();
    detectionQueueDepth = (detCounts as any).waiting || 0;
    alertQueueDepth = (alertCounts as any).waiting || 0;
  } catch {
    // Queue unavailable
  }

  const dbIsHealthy = dbHealth?.writePool?.connected === true && dbHealth?.readPool?.connected === true;
  const allHealthy = dbIsHealthy && redisHealthy;

  let websocketStats = {
    enabled: env.WEBSOCKET_ENABLED,
    connectedClients: 0,
    rooms: 0,
  };

  try {
    const io = getIO();
    websocketStats.connectedClients = io.sockets.sockets.size;
    websocketStats.rooms = io.sockets.adapter.rooms.size;
  } catch {
    // WebSocket not initialized or disabled
  }

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ok' : 'error',
    db: dbHealth,
    redis: {
      status: redisHealthy ? 'ok' : 'error',
      latencyMs: redisLatencyMs,
    },
    queue: {
      detectionQueueDepth,
      alertQueueDepth,
    },
    websocket: websocketStats,
    uptime: process.uptime(),
    version: '1.0.0',
  });
});

// Prometheus Metrics Endpoint
app.get('/metrics', async (req, res) => {
  if (!env.METRICS_ENABLED) {
    res.status(404).send('Metrics disabled');
    return;
  }

  const secret = req.headers['metrics-secret'];
  if (!secret || secret !== env.METRICS_SECRET) {
    res.status(401).send('Unauthorized: Invalid or missing METRICS_SECRET header');
    return;
  }

  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

// Setup Bull Board diagnostics dashboard for development
if (env.BULL_BOARD_ENABLED) {
  if (process.env.NODE_ENV !== 'test') {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');

    createBullBoard({
      queues: [
        new BullMQAdapter(detectionQueue),
        new BullMQAdapter(alertQueue),
        new BullMQAdapter(cleanupQueue),
        new BullMQAdapter(reportQueue),
      ],
      serverAdapter,
    });

    app.use(
      '/admin/queues',
      (req, res, next) => {
        if (process.env.MOCK_INFRA === 'true') {
          next();
          return;
        }
        const secret = req.headers['x-admin-secret'] || req.query.secret;
        if (!secret || secret !== env.ADMIN_SECRET) {
          res.status(401).send('Unauthorized: Invalid or missing X-Admin-Secret header or ?secret= query parameter');
          return;
        }
        next();
      },
      serverAdapter.getRouter()
    );
    logger.info('🚀 Bull Board dashboard initialized at /admin/queues');
  } else {
    app.use(
      '/admin/queues',
      (req, res, next) => {
        if (process.env.MOCK_INFRA === 'true') {
          next();
          return;
        }
        const secret = req.headers['x-admin-secret'] || req.query.secret;
        if (!secret || secret !== env.ADMIN_SECRET) {
          res.status(401).send('Unauthorized: Invalid or missing X-Admin-Secret header or ?secret= query parameter');
          return;
        }
        next();
      },
      (_req, res) => {
        res.status(200).send('Mock Bull Board Active');
      }
    );
  }
}

// 7. Register Application Routes
const bypassIfClientApiKey = (router: express.Router) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers['x-api-key'];
    const isApiKey = (authHeader && (authHeader.startsWith('ts_live_') || authHeader.startsWith('Bearer ts_live_'))) || apiKeyHeader;
    if (isApiKey) {
      return next();
    }
    return router(req, res, next);
  };
};

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1', bypassIfClientApiKey(orgRoutes));
app.use('/api/v1/users', bypassIfClientApiKey(userRoutes));
app.use('/api/v1', bypassIfClientApiKey(uploadRoutes));
app.use('/api/v1', bypassIfClientApiKey(jobRoutes));
app.use('/api/v1', bypassIfClientApiKey(alertRoutes));
app.use('/api/v1', bypassIfClientApiKey(reviewRoutes));
app.use('/api/v1', bypassIfClientApiKey(dashboardRoutes));
app.use('/api/v1', bypassIfClientApiKey(reportRoutes));
app.use('/api/v1/api-keys', bypassIfClientApiKey(apikeyRoutes));
app.use('/api/v1', bypassIfClientApiKey(billingRoutes));
app.use('/api', clientApiRoutes);

// 8. 404 handler for unmatched routes
app.use((req, _res, next) => {
  next(new NotFoundError(`Route ${req.originalUrl} not found`));
});

// 9. Centralized Error Handler Middleware
app.use(errorHandler);

export default app;
export { app };
