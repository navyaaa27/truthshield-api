import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import hpp from 'hpp';
import mongoSanitize from 'express-mongo-sanitize';
import morgan from 'morgan';
import { errorHandler, NotFoundError } from './middleware/error.js';
import { logger, createRequestLogger } from './utils/logger.js';
import { env } from './config/env.js';
import authRoutes from './modules/auth/auth.routes.js';
import orgRoutes from './modules/organizations/organization.routes.js';
import userRoutes from './modules/users/users.routes.js';
import uploadRoutes from './modules/uploads/upload.routes.js';
import jobRoutes from './modules/jobs/job.routes.js';
import alertRoutes from './modules/alerts/alert.routes.js';
import { checkDatabaseHealth } from './shared/database/index.js';
import { checkRedisHealth } from './shared/redis/index.js';
import { createBullBoard } from '@bull-board/api';
// @ts-ignore
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { detectionQueue, alertQueue, cleanupQueue } from './shared/queue/queues.js';

const app = express();

// 1. Trace log initialization (injects X-Request-ID and tracks incoming headers)
app.use(createRequestLogger());

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

// 5. Hardened request body parsing limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

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
  const dbHealthy = await checkDatabaseHealth();
  const redisHealthy = await checkRedisHealth();
  const allHealthy = dbHealthy && redisHealthy;

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ok' : 'error',
    db: dbHealthy ? 'ok' : 'error',
    redis: redisHealthy ? 'ok' : 'error',
    uptime: process.uptime(),
  });
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
      ],
      serverAdapter,
    });

    app.use(
      '/admin/queues',
      (req, res, next) => {
        const secret = req.headers['x-admin-secret'];
        if (!secret || secret !== env.ADMIN_SECRET) {
          res.status(401).send('Unauthorized: Invalid or missing X-Admin-Secret header');
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
        const secret = req.headers['x-admin-secret'];
        if (!secret || secret !== env.ADMIN_SECRET) {
          res.status(401).send('Unauthorized: Invalid or missing X-Admin-Secret header');
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
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1', orgRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1', uploadRoutes);
app.use('/api/v1', jobRoutes);
app.use('/api/v1', alertRoutes);

// 8. 404 handler for unmatched routes
app.use((req, _res, next) => {
  next(new NotFoundError(`Route ${req.originalUrl} not found`));
});

// 9. Centralized Error Handler Middleware
app.use(errorHandler);

export default app;
export { app };
