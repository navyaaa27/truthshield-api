import { initializeTracing } from './shared/tracing/tracing.js';
initializeTracing();

import http from 'http';
import { app } from './app.js';
import { env } from './config/env.js';
import { pool } from './shared/database/index.js';
import { redis } from './shared/redis/index.js';
import { logger } from './utils/logger.js';

const server = http.createServer(app);

async function bootstrap() {
  try {
    // 1. Verify Database Connection
    logger.info('Connecting to PostgreSQL database...');
    const dbClient = await pool.connect();
    dbClient.release();
    logger.info('PostgreSQL connection established successfully.');

    // 2. Verify Redis Connection
    logger.info('Connecting to Redis server...');
    await redis.ping();
    logger.info('Redis connection established successfully.');

    // 2.5 Initialize repeatable scheduled jobs (e.g. hourly SLA checks)
    const { setupScheduledJobs } = await import('./shared/queue/scheduled.jobs.js');
    await setupScheduledJobs();

    // 2.7 Initialize WebSocket Server
    const { initializeWebSocket } = await import('./shared/websocket/socket.server.js');
    initializeWebSocket(server);

    // 3. Start Express HTTP Server
    server.listen(env.PORT, () => {
      logger.info(`🚀 TruthShield API running in [${env.NODE_ENV}] mode on port ${env.PORT}`);
    });
  } catch (error: any) {
    logger.error(`Failed to bootstrap application: ${error.message}`);
    process.exit(1);
  }
}

// Graceful Shutdown Handler
async function gracefulShutdown(signal: string) {
  logger.warn(`Received ${signal}. Starting graceful shutdown...`);

  // Stop accepting new HTTP requests
  server.close(async () => {
    logger.info('HTTP server closed.');

    try {
      // Close WebSocket server
      logger.info('Closing WebSocket server...');
      const { closeWebSocket } = await import('./shared/websocket/socket.server.js');
      await closeWebSocket();
      logger.info('WebSocket server closed.');

      // Close Database Pool
      logger.info('Closing database connection pool...');
      await pool.end();
      logger.info('Database pool closed.');

      // Close Redis connection
      logger.info('Closing Redis connection...');
      await redis.quit();
      logger.info('Redis connection closed.');

      logger.info('Graceful shutdown completed. Exiting.');
      process.exit(0);
    } catch (error: any) {
      logger.error(`Error during graceful shutdown: ${error.message}`);
      process.exit(1);
    }
  });

  // Force close after 10 seconds
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
}

// Hook signals for graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Uncaught exceptions & unhandled rejections handler
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception occurred!', { stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
  logger.error('Unhandled Promise Rejection occurred!', {
    reason: reason instanceof Error ? reason.stack : reason,
  });
  process.exit(1);
});

bootstrap();
export { server };
