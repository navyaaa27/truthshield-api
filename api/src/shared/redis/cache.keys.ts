/**
 * Centralized cache key builder — all Redis key strings live here.
 * Ensures consistency and prevents key collisions.
 */
export const CacheKeys = {
  orgProfile: (orgId: string): string =>
    `org:${orgId}:profile`,

  jobsList: (orgId: string, status: string, page: number, limit: number): string =>
    `org:${orgId}:jobs:${status || 'all'}:${page}:${limit}`,

  jobDetail: (orgId: string, jobId: string): string =>
    `org:${orgId}:job:${jobId}`,

  alertsList: (orgId: string, filters: Record<string, unknown>, page: number): string =>
    `org:${orgId}:alerts:${JSON.stringify(filters)}:${page}`,

  alertStats: (orgId: string): string =>
    `org:${orgId}:alert_stats`,

  rateLimit: (identifier: string, window: string): string =>
    `rl:${identifier}:${window}`,

  mfaSetup: (userId: string): string =>
    `mfa_setup:${userId}`,

  tokenBlacklist: (jti: string): string =>
    `blacklist:${jti}`,

  pHashIndex: (orgId: string): string =>
    `phash_index:${orgId}`,

  assetHash: (s3Key: string): string =>
    `hash:${s3Key}`,

  dashboardOverview: (orgId: string): string => 
    `org:${orgId}:dashboard:overview`,

  dashboardFeed: (orgId: string, filters: Record<string, unknown>): string => 
    `org:${orgId}:dashboard:feed:${JSON.stringify(filters)}`,

  dashboardTrends: (orgId: string, days: number): string => 
    `org:${orgId}:dashboard:trends:${days}`,

  dashboardModules: (orgId: string, days: number): string => 
    `org:${orgId}:dashboard:modules:${days}`,

  apiKey: (hash: string): string =>
    `apikey:${hash}`,
};
