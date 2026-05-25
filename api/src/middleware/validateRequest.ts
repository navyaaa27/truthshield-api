import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import { ValidationError } from './errorHandler.js';

/**
 * Express middleware wrapper to evaluate express-validator results.
 * Throws a ValidationError containing structured field-level errors on validation failure.
 */
export function validateRequest(req: Request, _res: Response, next: NextFunction): void {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new ValidationError('Validation failed', errors.array());
  }
  next();
}

export default validateRequest;
