import { authenticate } from './authenticate.js';
import { authorize } from './authorize.js';

/**
 * Backward-compatible bridge pointing requireAuth directly to the new authenticate middleware
 */
export const requireAuth = authenticate;

/**
 * Backward-compatible bridge mapping requireRoles arrays to the new variadic authorize factory
 */
export function requireRoles(roles: string[]) {
  return authorize(...roles);
}
