import slowDown from 'express-slow-down';
import RedisStore from 'rate-limit-redis';
import { redisClient } from '../shared/redis/redis.client.js';
import { env } from '../config/env.js';

const skipTrustedIps = (req: any) => {
  if (!env.RATE_LIMIT_SKIP_TRUSTED_IPS) return false;
  const trusted = env.RATE_LIMIT_SKIP_TRUSTED_IPS.split(',').map(i => i.trim());
  return trusted.includes(req.ip || '');
};

const skipSlowDown = (req: any) => {
  if (process.env.NODE_ENV === 'test' && process.env.ENABLE_SECURITY_MIDDLEWARE !== 'true') {
    return true;
  }
  return skipTrustedIps(req);
};

const createSlowDownStore = () => {
  if (process.env.MOCK_INFRA === 'true' || redisClient.status !== 'ready') {
    return undefined;
  }
  return new RedisStore({
    // @ts-ignore
    sendCommand: (...args: string[]) => redisClient.call(...args),
    prefix: 'ts:sd:auth:',
  });
};

const store = createSlowDownStore();

export const authSlowDown = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 3, // allow 3 requests to go at full-speed, then...
  delayMs: (hits) => {
    // 4th request: 500ms
    // 5th request: 500ms
    // 6th request: 2000ms
    return hits >= 5 ? 2000 : 500;
  },
  store: store as any,
  skip: skipSlowDown,
});
