import winston from 'winston';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

/**
 * Deep-walks an object, replacing sensitive keys (passwords, tokens, API keys, secrets) with [REDACTED].
 */
export function sanitizeLog(data: any): any {
  if (!data) return data;
  if (typeof data !== 'object') return data;
  if (data instanceof Date) return data;
  if (Array.isArray(data)) {
    return data.map(sanitizeLog);
  }

  const sanitized: any = {};
  const sensitiveKeys = [
    'password',
    'token',
    'mfa_secret',
    'api_key',
    'accesstoken',
    'refreshtoken',
    'temptoken',
    'totpcode',
    'secret',
    'mfa_secret_encrypted',
    'authorization',
  ];

  for (const key of Object.keys(data)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some((sk) => lowerKey.includes(sk))) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = sanitizeLog(data[key]);
    }
  }

  return sanitized;
}

// Custom format wrapper to automatically sanitize log values
const sanitizeFormat = winston.format((info) => {
  if (info.message && typeof info.message === 'object') {
    info.message = sanitizeLog(info.message);
  } else if (info.message && typeof info.message === 'string') {
    // If message looks like JSON, attempt to parse and sanitize
    if (info.message.startsWith('{') || info.message.startsWith('[')) {
      try {
        const parsed = JSON.parse(info.message);
        info.message = JSON.stringify(sanitizeLog(parsed));
      } catch {
        // Fallback to plain string message
      }
    }
  }

  // Sanitize any other custom fields or metadata attached to the log
  for (const key of Object.keys(info)) {
    if (key !== 'level' && key !== 'timestamp' && key !== 'requestId') {
      info[key] = sanitizeLog(info[key]);
    }
  }

  return info;
});

// Configure Winston Transports (production is stdout console only, no file logs)
const transports = [new winston.transports.Console()];

// Set Log Levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Colors mapping for development mode
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'cyan',
};
winston.addColors(colors);

// Configure Logging Format by Node environment
const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  sanitizeFormat(),
  env.NODE_ENV === 'production'
    ? winston.format.json()
    : winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.printf((info) => {
          const reqIdStr = info.requestId ? ` [reqId:${info.requestId}]` : '';
          const msg = typeof info.message === 'object' ? JSON.stringify(info.message) : info.message;
          return `[${info.timestamp}] [${info.level}]${reqIdStr}: ${msg}`;
        })
      )
);

// Instantiate singleton Winston Logger
export const logger = winston.createLogger({
  level: env.NODE_ENV === 'development' ? 'debug' : 'info',
  levels,
  format,
  transports,
});

/**
 * Express middleware to assign X-Request-ID and log details of incoming requests
 */
export function createRequestLogger() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Get or generate X-Request-ID using native crypto.randomUUID()
    let requestId = req.headers['x-request-id'] as string;
    if (!requestId) {
      requestId = crypto.randomUUID();
    }

    // Bind request ID to Express headers and response headers
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-ID', requestId);

    logger.info({
      message: `${req.method} ${req.originalUrl || req.url}`,
      requestId,
      method: req.method,
      url: req.url,
      ip: req.ip,
    });

    next();
  };
}

export default logger;
