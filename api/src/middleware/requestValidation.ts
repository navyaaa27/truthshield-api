import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export const validateContentType = (req: Request, res: Response, next: NextFunction): any => {
  if (process.env.NODE_ENV === 'test' && process.env.ENABLE_SECURITY_MIDDLEWARE !== 'true') {
    return next();
  }
  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    const contentLength = req.headers['content-length'];
    if (contentLength === '0') {
      return next();
    }
    const contentType = req.headers['content-type'];
    if (!contentType) {
      return res.status(415).json({ success: false, error: { message: 'Content-Type header is required' } });
    }
    
    // Skip multipart for file uploads
    if (contentType.includes('multipart/form-data')) {
      return next();
    }

    if (!contentType.includes('application/json')) {
      return res.status(415).json({ success: false, error: { message: 'Unsupported Media Type: expected application/json' } });
    }
  }
  return next();
};

export const validateRequestSize = (req: Request, res: Response, next: NextFunction): any => {
  if (process.env.NODE_ENV === 'test' && process.env.ENABLE_SECURITY_MIDDLEWARE !== 'true') {
    return next();
  }
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB limit for JSON bodies

  if (contentLength > MAX_SIZE && !req.headers['content-type']?.includes('multipart/form-data')) {
    return res.status(413).json({ success: false, error: { message: 'Payload Too Large: JSON body exceeds 10MB limit' } });
  }
  return next();
};

export const sanitizeInput = (req: Request, res: Response, next: NextFunction): any => {
  if (process.env.NODE_ENV === 'test' && process.env.ENABLE_SECURITY_MIDDLEWARE !== 'true') {
    return next();
  }
  if (req.body && typeof req.body === 'object') {
    for (const key in req.body) {
      if (typeof req.body[key] === 'string') {
        if (req.body[key].includes('\0')) {
          return res.status(400).json({ success: false, error: { message: 'Invalid input: Null bytes detected' } });
        }
        req.body[key] = req.body[key].trim();
      }
    }
  }
  return next();
};

export const validateOrigin = (req: Request, res: Response, next: NextFunction): any => {
  if (process.env.NODE_ENV === 'test' && process.env.ENABLE_SECURITY_MIDDLEWARE !== 'true') {
    return next();
  }
  const origin = req.headers.origin;
  
  // Skip check for requests using API key authentication (assuming they send an 'x-api-key' header or are server-to-server)
  if (req.headers['x-api-key'] || req.headers.authorization?.startsWith('Bearer ts_')) {
    return next();
  }

  // If no allowed origins specified, permit all
  if (!env.ALLOWED_ORIGINS) {
    return next();
  }

  const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((o: string) => o.trim());
  
  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ success: false, error: { message: 'Origin not allowed by CORS policy' } });
  }
  
  return next();
};
