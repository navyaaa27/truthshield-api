import { detectionQueue, alertQueue } from '../queue/queues.js';
import { updatePoolMetrics } from '../database/pool.js';
import { isRedisHealthy } from '../redis/redis.client.js';
import { logger } from '../../utils/logger.js';
import {
  detectionQueueDepth,
  activeDetectionWorkers,
  redisConnected,
} from './metrics.service.js';

export class QueueMonitor {
  private intervalId?: NodeJS.Timeout;
  private dbIntervalId?: NodeJS.Timeout;

  start(): void {
    logger.info('Queue & Resource Monitor started.');
    
    // Poll queue sizes and redis status on 30 second interval
    this.intervalId = setInterval(async () => {
      try {
        await this.pollQueues();
        await this.pollRedis();
      } catch (err: any) {
        logger.error(`Error polling queues/redis in monitor: ${err.message}`);
      }
    }, 30000);

    // Poll DB pool connection counts on 30 second interval
    this.dbIntervalId = setInterval(async () => {
      try {
        await this.pollDatabase();
      } catch (err: any) {
        logger.error(`Error polling database pool in monitor: ${err.message}`);
      }
    }, 30000);

    // Run synchronous immediate poll upon startup
    this.pollQueues().catch(() => {});
    this.pollRedis().catch(() => {});
    this.pollDatabase().catch(() => {});
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    if (this.dbIntervalId) {
      clearInterval(this.dbIntervalId);
    }
    logger.info('Queue & Resource Monitor stopped.');
  }

  async pollQueues(): Promise<void> {
    try {
      const detectionCounts = await detectionQueue.getJobCounts();
      const alertCounts = await alertQueue.getJobCounts();

      const detDepth = (detectionCounts.waiting || 0) + (detectionCounts.delayed || 0);
      const alDepth = (alertCounts.waiting || 0) + (alertCounts.delayed || 0);
      const totalDepth = detDepth + alDepth;

      // Update gauges
      detectionQueueDepth.set(totalDepth);

      const activeWorkersCount = (detectionCounts.active || 0) + (alertCounts.active || 0);
      activeDetectionWorkers.set(activeWorkersCount);

      // Warning thresholds
      if (totalDepth > 5000) {
        logger.error(`🚨 CRITICAL: High Backpressure detected! Queue depth is ${totalDepth}. Scale up needed immediately.`);
      } else if (totalDepth > 1000) {
        logger.warn(`⚠️ WARNING: Backpressure detected! Queue depth is ${totalDepth}.`);
      }
    } catch (err: any) {
      logger.warn(`Failed to read BullMQ counts: ${err.message}`);
    }
  }

  async pollRedis(): Promise<void> {
    try {
      const healthy = await isRedisHealthy();
      redisConnected.set(healthy ? 1 : 0);
    } catch {
      redisConnected.set(0);
    }
  }

  async pollDatabase(): Promise<void> {
    try {
      updatePoolMetrics();
    } catch (err: any) {
      logger.warn(`Failed to read Postgres pool stats: ${err.message}`);
    }
  }
}

export const queueMonitor = new QueueMonitor();
export default queueMonitor;
