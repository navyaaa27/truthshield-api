import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Base Application Error representing checked errors in the TruthShield domain.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details: any;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details: any = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Thrown on invalid request schemas or validation errors.
 */
export class ValidationError extends AppError {
  constructor(message: string, details: any = null) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

/**
 * Thrown on bad credentials, expired tokens, or unauthenticated operations.
 */
export class AuthError extends AppError {
  constructor(message: string) {
    super(message, 401, 'UNAUTHORIZED');
  }
}

/**
 * Thrown when authenticated users operate outside authorized roles.
 */
export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(message, 403, 'FORBIDDEN');
  }
}

/**
 * Thrown when resource fetches fail to yield database hits.
 */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404, 'NOT_FOUND');
  }
}

/**
 * Thrown on email conflict, database constraint blocks, or transaction overlaps.
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}

/**
 * Global Error Handler Express Middleware
 */
export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = (req.headers['x-request-id'] as string) || '';

  let statusCode = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Internal Server Error';
  let details: any = null;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else {
    // If it's a generic internal script exception, preserve actual message only in non-production
    if (env.NODE_ENV === 'development') {
      message = err.message || message;
    }
  }

  // Log error using Winston, correlating with requestId
  logger.error({
    message: `${req.method} ${req.originalUrl || req.url} - Error: ${err.message}`,
    requestId,
    statusCode,
    code,
    stack: err.stack,
    details,
  });

  // Construct standard consistent error shape
  const errorResponse: any = {
    success: false,
    error: {
      code,
      message,
      requestId,
    },
  };

  // Expose system debug data only under local development configuration
  if (env.NODE_ENV === 'development') {
    errorResponse.error.stack = err.stack;
    if (details) {
      errorResponse.error.details = details;
    }
  }

  res.status(statusCode).json(errorResponse);
}
export default errorHandler;
