import crypto from 'crypto';

/**
 * Generates a random 48-character API key prefixed with 'ts_live_'
 */
export function generateApiKey(): string {
  // 'ts_live_' is 8 characters. We generate 20 random bytes (40 hex chars) to sum to 48 characters.
  const randomHex = crypto.randomBytes(20).toString('hex');
  return `ts_live_${randomHex}`;
}

/**
 * Returns the SHA-256 hash of an API key for safe database storage.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}
