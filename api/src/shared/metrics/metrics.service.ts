import client from 'prom-client';
import { Request, Response, NextFunction } from 'express';
import onFinished from 'on-finished';

// Configure and enable default metrics capture
client.collectDefaultMetrics({ register: client.register });

// 1. Prometheus Counters
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests processed by endpoint',
  labelNames: ['method', 'route', 'status_code'],
});

export const detectionJobsTotal = new client.Counter({
  name: 'detection_jobs_total',
  help: 'Total module execution counts',
  labelNames: ['module', 'verdict', 'org_plan'],
});

export const detectionJobsFailedTotal = new client.Counter({
  name: 'detection_jobs_failed_total',
  help: 'Total module execution failures',
  labelNames: ['module', 'error_type'],
});

export const authEventsTotal = new client.Counter({
  name: 'auth_events_total',
  help: 'Auth operations event tracker',
  labelNames: ['event_type', 'success'],
});

export const alertsGeneratedTotal = new client.Counter({
  name: 'alerts_generated_total',
  help: 'Application alerts dispatched by severity',
  labelNames: ['severity'],
});

export const cacheOperationsTotal = new client.Counter({
  name: 'cache_operations_total',
  help: 'Cache hits, misses and error logs',
  labelNames: ['operation', 'result'],
});

// 2. Prometheus Histograms
export const httpRequestDurationMs = new client.Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP latency buckets in milliseconds',
  labelNames: ['method', 'route'],
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
});

export const detectionJobDurationMs = new client.Histogram({
  name: 'detection_job_duration_ms',
  help: 'Detection module processing duration in milliseconds',
  labelNames: ['module', 'content_type'],
  buckets: [100, 500, 1000, 5000, 15000, 30000, 60000],
});

export const externalApiDurationMs = new client.Histogram({
  name: 'external_api_duration_ms',
  help: 'External service latency trackers',
  labelNames: ['service', 'endpoint'],
  buckets: [50, 100, 250, 500, 1000, 3000, 10000],
});

// 3. Prometheus Gauges
export const detectionQueueDepth = new client.Gauge({
  name: 'detection_queue_depth',
  help: 'Active jobs currently queued in BullMQ',
});

export const activeDetectionWorkers = new client.Gauge({
  name: 'active_detection_workers',
  help: 'Concurrency capacity being consumed by active workers',
});

export const redisConnected = new client.Gauge({
  name: 'redis_connected',
  help: 'Redis health connection gauge (0=Disconnected, 1=Connected)',
});

export const dbPoolSize = new client.Gauge({
  name: 'db_pool_size',
  help: 'Total postgres database clients',
});

export const dbPoolIdle = new client.Gauge({
  name: 'db_pool_idle',
  help: 'Total database clients currently sitting idle',
});

export const dbPoolWaiting = new client.Gauge({
  name: 'db_pool_waiting',
  help: 'Total database clients waiting for connection',
});

export const dbQueryDurationMs = new client.Histogram({
  name: 'db_query_duration_ms',
  help: 'Database query duration in milliseconds',
  labelNames: ['operation', 'module'],
  buckets: [1, 5, 10, 50, 100, 250, 500, 1000, 5000],
});

/**
 * Middleware to record HTTP latency and request statuses
 */
export const recordHttpRequest = () => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const url = req.originalUrl || req.url;
    if (url === '/metrics') {
      return next();
    }

    const start = process.hrtime();

    onFinished(res, () => {
      const diff = process.hrtime(start);
      const durationMs = Math.round((diff[0] * 1e9 + diff[1]) / 1e6);
      const route = req.route?.path || url || 'unknown';
      const method = req.method;
      const status = String(res.statusCode);

      httpRequestsTotal.inc({ method, route, status_code: status });
      httpRequestDurationMs.observe({ method, route }, durationMs);
    });

    next();
  };
};

/**
 * Recorder for Job execution statistics
 */
export const recordDetectionJob = (
  moduleName: string,
  verdict: string,
  orgPlan: string,
  contentType: string,
  durationMs: number,
): void => {
  detectionJobsTotal.inc({ module: moduleName, verdict, org_plan: orgPlan });
  detectionJobDurationMs.observe({ module: moduleName, content_type: contentType }, durationMs);
};

/**
 * Execution wrapper to automatically time external API service dependencies
 */
export async function recordExternalApi<T>(
  service: string,
  endpoint: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = process.hrtime();
  try {
    const result = await fn();
    return result;
  } finally {
    const diff = process.hrtime(start);
    const durationMs = Math.round((diff[0] * 1e9 + diff[1]) / 1e6);
    externalApiDurationMs.observe({ service, endpoint }, durationMs);
  }
}

export const register = client.register;
export default {
  recordHttpRequest,
  recordDetectionJob,
  recordExternalApi,
  register,
};
