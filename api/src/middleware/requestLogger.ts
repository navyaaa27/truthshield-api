import { Request, Response, NextFunction } from 'express';
import onFinished from 'on-finished';
import { logger, clsNamespace } from '../utils/logger.js';

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const url = req.originalUrl || req.url;

  // Skip logging for GET /health endpoint to prevent log pollution
  if (req.method === 'GET' && url === '/health') {
    return next();
  }

  const start = process.hrtime();
  const ip = req.ip || req.socket.remoteAddress || '';
  const userAgent = req.headers['user-agent'] || '';

  // Retrieve current active CLS variables if present
  const requestId = clsNamespace.get('requestId');
  const orgId = clsNamespace.get('orgId');
  const userId = clsNamespace.get('userId');

  logger.info({
    message: `Request Started: ${req.method} ${url}`,
    method: req.method,
    url,
    ip,
    userAgent,
    requestId,
    orgId,
    userId,
  });

  // Track finished request via onFinished
  onFinished(res, (err, finishedRes) => {
    const diff = process.hrtime(start);
    const durationMs = Math.round((diff[0] * 1e9 + diff[1]) / 1e6);
    const statusCode = finishedRes.statusCode;
    const contentLength = finishedRes.getHeader('content-length') || 0;

    // Dynamically assign standard log severity based on response status code
    let logLevel: 'info' | 'warn' | 'error' = 'info';
    if (statusCode >= 500) {
      logLevel = 'error';
    } else if (statusCode >= 400) {
      logLevel = 'warn';
    }

    const logData: Record<string, any> = {
      message: `Request Completed: ${req.method} ${url} with status ${statusCode}`,
      method: req.method,
      url,
      statusCode,
      durationMs,
      contentLength,
      ip,
      userAgent,
      requestId: clsNamespace.get('requestId') || requestId,
      orgId: clsNamespace.get('orgId') || orgId,
      userId: clsNamespace.get('userId') || userId,
    };

    if (err) {
      logData.error = {
        message: err.message,
        stack: err.stack,
      };
    }

    logger[logLevel](logData);
  });

  next();
};

export default requestLogger;
