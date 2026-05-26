export const SCOPES = {
  JOBS_CREATE: 'jobs:create',
  JOBS_READ: 'jobs:read',
  RESULTS_READ: 'results:read',
  ALERTS_READ: 'alerts:read',
  UPLOADS_CREATE: 'uploads:create',
  ASSETS_READ: 'assets:read',
  ASSETS_WRITE: 'assets:write',
  REPORTS_READ: 'reports:read',
  WEBHOOKS_MANAGE: 'webhooks:manage',
} as const;

export type ApiKeyScope = typeof SCOPES[keyof typeof SCOPES];

export interface ApiKey {
  id: string;
  org_id: string;
  created_by: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: string[];
  allowed_ips: string[] | null;
  rate_limit_override: number | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  expires_at: string | null;
  is_active: boolean;
  revoked_at: string | null;
  revoked_by: string | null;
  total_requests: number;
  created_at: string;
}
