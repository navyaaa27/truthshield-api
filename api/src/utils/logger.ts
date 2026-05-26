import winston from 'winston';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import WinstonCloudWatch from 'winston-cloudwatch';
import os from 'os';
import { createNamespace, getNamespace } from 'cls-hooked';

// Initialize CLS Namespace for request tracking
export const clsNamespace = createNamespace('truthshield-cls');

/**
 * Deep-walks an object recursively to redact sensitive keys.
 * Correctly handles circular references using ancestor tracking.
 */
export function sanitizeForLog(obj: unknown, visited = new WeakSet<any>()): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  // Skip special built-in structures
  if (obj instanceof Date || obj instanceof RegExp || obj instanceof Buffer) {
    return obj;
  }

  if (visited.has(obj)) {
    return '[Circular]';
  }

  visited.add(obj);

  if (Array.isArray(obj)) {
    const result = obj.map((item) => sanitizeForLog(item, visited));
    visited.delete(obj);
    return result;
  }

  const sensitiveKeys = new Set([
    'password',
    'passwordhash',
    'password_hash',
    'token',
    'accesstoken',
    'access_token',
    'refreshtoken',
    'refresh_token',
    'mfasecret',
    'mfa_secret',
    'apikey',
    'api_key',
    'apikeyhash',
    'api_key_hash',
    'secret',
    'authorization',
    'cookie',
    'totpcode',
    'totp_code',
    'totpsecret',
    'totp_secret',
  ]);

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj as Record<string, any>)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.has(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = sanitizeForLog(value, visited);
    }
  }

  visited.delete(obj);
  return sanitized;
}

// Custom formatting logic for automatic object sanitization
const sanitizeFormat = winston.format((info) => {
  // Sanitize the message itself if it's an object
  if (info.message && typeof info.message === 'object') {
    info.message = sanitizeForLog(info.message) as any;
  } else if (info.message && typeof info.message === 'string') {
    if (info.message.startsWith('{') || info.message.startsWith('[')) {
      try {
        const parsed = JSON.parse(info.message);
        info.message = JSON.stringify(sanitizeForLog(parsed)) as any;
      } catch {
        // Fallback to plain string message
      }
    }
  }

  const sensitiveKeys = new Set([
    'password',
    'passwordhash',
    'password_hash',
    'token',
    'accesstoken',
    'access_token',
    'refreshtoken',
    'refresh_token',
    'mfasecret',
    'mfa_secret',
    'apikey',
    'api_key',
    'apikeyhash',
    'api_key_hash',
    'secret',
    'authorization',
    'cookie',
    'totpcode',
    'totp_code',
    'totpsecret',
    'totp_secret',
  ]);

  // Sanitize all custom fields/metadata attached to the log
  for (const key of Object.keys(info)) {
    if (key !== 'level' && key !== 'timestamp' && key !== 'requestId') {
      const lowerKey = key.toLowerCase();
      if (sensitiveKeys.has(lowerKey)) {
        info[key] = '[REDACTED]';
      } else {
        info[key] = sanitizeForLog(info[key]);
      }
    }
  }

  return info;
});

// CLS context propagation format middleware
const clsFormat = winston.format((info) => {
  const ns = getNamespace('truthshield-cls');
  if (ns && ns.active) {
    const requestId = ns.get('requestId');
    const orgId = ns.get('orgId');
    const userId = ns.get('userId');
    const jobId = ns.get('jobId');
    const moduleName = ns.get('module');

    if (requestId && !info.requestId) info.requestId = requestId;
    if (orgId && !info.orgId) info.orgId = orgId;
    if (userId && !info.userId) info.userId = userId;
    if (jobId && !info.jobId) info.jobId = jobId;
    if (moduleName && !info.module) info.module = moduleName;
  }
  return info;
});

// Configure Winston log levels and color coding
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'cyan',
};
winston.addColors(colors);

// Configure Console Transport
const transports: winston.transport[] = [
  new winston.transports.Console({
    level: env.LOG_LEVEL || (env.NODE_ENV === 'development' ? 'debug' : 'info'),
  }),
];

// Add CloudWatch Transport in production if valid credentials are found
const hasAwsCreds = (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) || process.env.AWS_ACCESS_KEY_ID;
if (env.NODE_ENV === 'production' && hasAwsCreds) {
  const dateStr = new Date().toISOString().split('T')[0];
  transports.push(
    new WinstonCloudWatch({
      logGroupName: env.CLOUDWATCH_LOG_GROUP,
      logStreamName: `${os.hostname()}-${dateStr}`,
      awsRegion: env.CLOUDWATCH_REGION,
      uploadRate: 2000,
      jsonMessage: true,
      awsOptions: {
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
      },
    }) as any
  );
}

// Build final format chain
const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  clsFormat(),
  sanitizeFormat(),
  env.NODE_ENV === 'production'
    ? winston.format.json()
    : winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.printf((info) => {
          const reqStr = info.requestId ? ` [reqId:${info.requestId}]` : '';
          const orgStr = info.orgId ? ` [orgId:${info.orgId}]` : '';
          const userStr = info.userId ? ` [userId:${info.userId}]` : '';
          const jobStr = info.jobId ? ` [jobId:${info.jobId}]` : '';
          const modStr = info.module ? ` [module:${info.module}]` : '';
          const durationStr = info.durationMs !== undefined ? ` [duration:${info.durationMs}ms]` : '';

          // Extract extra metadata
          const meta = { ...info } as any;
          delete meta.timestamp;
          delete meta.level;
          delete meta.message;
          delete meta.requestId;
          delete meta.orgId;
          delete meta.userId;
          delete meta.jobId;
          delete meta.module;
          delete meta.durationMs;
          delete meta.error;

          let metaStr = '';
          if (Object.keys(meta).length > 0) {
            metaStr = ` | meta: ${JSON.stringify(meta)}`;
          }

          let errStr = '';
          if (info.error) {
            const err = info.error as any;
            errStr = ` | error: ${err.message}${err.code ? ` (${err.code})` : ''}`;
            if (env.NODE_ENV !== 'production' && err.stack) {
              errStr += `\n${err.stack}`;
            }
          }

          return `[${info.timestamp}] [${info.level}]${reqStr}${orgStr}${userStr}${jobStr}${modStr}${durationStr}: ${info.message}${errStr}${metaStr}`;
        })
      )
);

export const logger = winston.createLogger({
  level: env.LOG_LEVEL || (env.NODE_ENV === 'development' ? 'debug' : 'info'),
  levels,
  format,
  transports,
});

/**
 * Express middleware to assign X-Request-ID and propagate details inside CLS
 */
export function createRequestLogger() {
  return (req: Request, res: Response, next: NextFunction): void => {
    let requestId = req.headers['x-request-id'] as string;
    if (!requestId) {
      requestId = crypto.randomUUID();
    }

    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-ID', requestId);

    // Bind values inside the active CLS Context
    clsNamespace.run(() => {
      clsNamespace.set('requestId', requestId);
      
      // Auto-extract user context if already populated (or placeholder)
      if ((req as any).user) {
        clsNamespace.set('orgId', (req as any).user.orgId);
        clsNamespace.set('userId', (req as any).user.id);
      }

      next();
    });
  };
}

// Deprecated function name compatibility mapping (calls sanitizeForLog)
export const sanitizeLog = sanitizeForLog;

export default logger;
