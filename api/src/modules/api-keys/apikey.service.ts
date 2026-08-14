import crypto from 'crypto';
import { isIP } from 'net';
import { query } from '../../shared/database/pool.js';
import { cacheService } from '../../shared/redis/cache.service.js';
import { CacheKeys } from '../../shared/redis/cache.keys.js';
import { logger } from '../../utils/logger.js';
import { ApiKey, SCOPES } from './apikey.types.js';

// CIDR/IP Verification Helper
export function isIpInCidr(ip: string, cidr: string): boolean {
  let cleanIp = ip;
  if (ip.startsWith('::ffff:')) {
    cleanIp = ip.substring(7);
  }

  if (!cidr.includes('/')) {
    let cleanCidr = cidr;
    if (cidr.startsWith('::ffff:')) {
      cleanCidr = cidr.substring(7);
    }
    return cleanIp === cleanCidr;
  }

  const parts = cidr.split('/');
  let cleanCidrIp = parts[0];
  if (cleanCidrIp.startsWith('::ffff:')) {
    cleanCidrIp = cleanCidrIp.substring(7);
  }
  const mask = parseInt(parts[1], 10);

  const ipType = isIP(cleanIp);
  const cidrType = isIP(cleanCidrIp);

  if (ipType !== cidrType || ipType === 0) {
    return false;
  }

  if (ipType === 4) {
    const ipNum =
      cleanIp.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
    const cidrNum =
      cleanCidrIp.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
    const shift = 32 - mask;
    const maskNum = (shift === 32 ? 0 : ~0 << shift) >>> 0;
    return (ipNum & maskNum) === (cidrNum & maskNum);
  } else {
    try {
      const expandIPv6 = (ipv6: string) => {
        let full = ipv6;
        if (ipv6.includes('::')) {
          const parts = ipv6.split('::');
          const left = parts[0] ? parts[0].split(':') : [];
          const right = parts[1] ? parts[1].split(':') : [];
          const missing = 8 - (left.length + right.length);
          const middle = Array(missing).fill('0000');
          full = [...left, ...middle, ...right].join(':');
        }
        return full
          .split(':')
          .map((part) => part.padStart(4, '0'))
          .join('');
      };

      const ipHex = expandIPv6(cleanIp);
      const cidrHex = expandIPv6(cleanCidrIp);

      const bitsToCompare = mask;
      const hexCharsToCompare = Math.floor(bitsToCompare / 4);
      const remainingBits = bitsToCompare % 4;

      if (ipHex.substring(0, hexCharsToCompare) !== cidrHex.substring(0, hexCharsToCompare)) {
        return false;
      }

      if (remainingBits > 0) {
        const ipChar = parseInt(ipHex[hexCharsToCompare], 16);
        const cidrChar = parseInt(cidrHex[hexCharsToCompare], 16);
        const shift = 4 - remainingBits;
        const maskBits = (0xf << shift) & 0xf;
        return (ipChar & maskBits) === (cidrChar & maskBits);
      }
      return true;
    } catch {
      return false;
    }
  }
}

// CIDR general validator
export function isValidCIDR(cidr: string): boolean {
  const parts = cidr.split('/');
  if (parts.length > 2) return false;

  const ip = parts[0];
  if (isIP(ip) === 0) return false;

  if (parts.length === 2) {
    const mask = parseInt(parts[1], 10);
    if (isNaN(mask)) return false;
    const isV6 = isIP(ip) === 6;
    if (isV6) {
      return mask >= 0 && mask <= 128;
    } else {
      return mask >= 0 && mask <= 32;
    }
  }
  return true;
}

export class ApiKeyService {
  /**
   * Generates a new cryptographically secure API key for an organization.
   */
  static async createApiKey(params: {
    orgId: string;
    createdBy: string;
    name: string;
    scopes: string[];
    allowedIps?: string[];
    expiresAt?: Date;
    rateLimitOverride?: number;
  }): Promise<{ apiKey: ApiKey; plainKey: string }> {
    const {
      orgId,
      createdBy,
      name,
      scopes,
      allowedIps = [],
      expiresAt,
      rateLimitOverride,
    } = params;

    // 1. Scope validation
    const allowedScopes = Object.values(SCOPES) as string[];
    for (const scope of scopes) {
      if (!allowedScopes.includes(scope)) {
        throw new Error(`Invalid API key scope: ${scope}`);
      }
    }

    // 2. IP validations (must be valid CIDR or IP)
    for (const ip of allowedIps) {
      if (!isValidCIDR(ip)) {
        throw new Error(`Invalid allowed IP or CIDR range: ${ip}`);
      }
    }

    // 3. Key generation
    const randomChars = crypto.randomBytes(16).toString('hex');
    const plainKey = `ts_live_${randomChars}`;
    const keyHash = crypto.createHash('sha256').update(plainKey).digest('hex');
    const keyPrefix = plainKey.substring(0, 12); // ts_live_{4 random chars}

    // 4. DB insertion
    const insertRes = await query(
      `INSERT INTO api_keys (
        org_id,
        created_by,
        name,
        key_hash,
        key_prefix,
        scopes,
        allowed_ips,
        rate_limit_override,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        orgId,
        createdBy,
        name,
        keyHash,
        keyPrefix,
        scopes,
        allowedIps.length > 0 ? allowedIps : null,
        rateLimitOverride || null,
        expiresAt || null,
      ],
    );

    const keyRecord = insertRes.rows[0];

    // 5. Log audit trail
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'API_KEY_CREATED', 'api_keys', $3)`,
      [orgId, createdBy, keyRecord.id],
    );

    logger.info(`[ApiKeyService] API Key '${name}' generated successfully under Org ${orgId}`);

    return {
      apiKey: keyRecord,
      plainKey,
    };
  }

  /**
   * Validates a provided API Key, doing cache-aside checking, IP verify, and usage increments.
   */
  static async validateApiKey(
    plainKey: string,
    remoteIp?: string,
  ): Promise<{
    valid: boolean;
    apiKey?: ApiKey;
    org?: { id: string; name: string; plan_tier: string };
    reason?: string;
  }> {
    if (!plainKey || !plainKey.startsWith('ts_live_')) {
      return { valid: false, reason: 'Invalid API Key format' };
    }

    const hash = crypto.createHash('sha256').update(plainKey).digest('hex');
    const cacheKey = CacheKeys.apiKey(hash);

    try {
      // 1. Fetch from cache or DB
      const cached = await cacheService.get<{
        apiKey: ApiKey;
        org: { id: string; name: string; plan_tier: string };
      }>(cacheKey);

      let record: any = null;
      let orgPayload: any = null;

      if (cached) {
        record = cached.apiKey;
        orgPayload = cached.org;
      } else {
        const dbRes = await query(
          `SELECT k.*, o.name as org_name, o.plan_tier as org_plan_tier
           FROM api_keys k
           JOIN organizations o ON k.org_id = o.id
           WHERE k.key_hash = $1`,
          [hash],
        );

        if (dbRes.rowCount === 0) {
          return { valid: false, reason: 'API Key not found or invalid' };
        }

        const dbRow = dbRes.rows[0];
        record = {
          id: dbRow.id,
          org_id: dbRow.org_id,
          created_by: dbRow.created_by,
          name: dbRow.name,
          key_hash: dbRow.key_hash,
          key_prefix: dbRow.key_prefix,
          scopes: dbRow.scopes,
          allowed_ips: dbRow.allowed_ips,
          rate_limit_override: dbRow.rate_limit_override,
          last_used_at: dbRow.last_used_at,
          last_used_ip: dbRow.last_used_ip,
          expires_at: dbRow.expires_at,
          is_active: dbRow.is_active,
          revoked_at: dbRow.revoked_at,
          revoked_by: dbRow.revoked_by,
          total_requests: dbRow.total_requests,
          created_at: dbRow.created_at,
        };

        orgPayload = {
          id: dbRow.org_id,
          name: dbRow.org_name,
          plan_tier: dbRow.org_plan_tier,
        };

        // Cache valid key for 5 minutes
        if (record.is_active) {
          await cacheService.set(cacheKey, { apiKey: record, org: orgPayload }, 300);
        }
      }

      // 2. Active checks
      if (!record.is_active) {
        return { valid: false, reason: 'API Key has been revoked or is inactive' };
      }

      // 3. Expiration checks
      if (record.expires_at && new Date(record.expires_at) < new Date()) {
        return { valid: false, reason: 'API Key has expired' };
      }

      // 4. IP allowlist checking
      if (record.allowed_ips && record.allowed_ips.length > 0) {
        if (!remoteIp) {
          return { valid: false, reason: 'IP validation required but remote IP is missing' };
        }
        const ipMatch = record.allowed_ips.some((cidr: string) => isIpInCidr(remoteIp, cidr));
        if (!ipMatch) {
          return {
            valid: false,
            reason: `IP address ${remoteIp} is not authorized by allowed_ips allowlist`,
          };
        }
      }

      // 5. Fire-and-forget usage logging
      query(
        `UPDATE api_keys
         SET last_used_at = NOW(),
             last_used_ip = $1,
             total_requests = total_requests + 1
         WHERE id = $2`,
        [remoteIp || null, record.id],
      ).catch((err) => {
        logger.error(`[ApiKeyService] Failed to update key usage statistics: ${err.message}`);
      });

      return {
        valid: true,
        apiKey: record,
        org: orgPayload,
      };
    } catch (err: any) {
      logger.error(`[ApiKeyService] Error during API key validation: ${err.message}`);
      return { valid: false, reason: 'Internal validation failure' };
    }
  }

  /**
   * Returns all API Keys for an organization (hashes redacted).
   */
  static async listApiKeys(orgId: string): Promise<Omit<ApiKey, 'key_hash'>[]> {
    const res = await query(
      `SELECT id, name, key_prefix, scopes, is_active, 
              last_used_at, expires_at, total_requests, created_at, allowed_ips, rate_limit_override
       FROM api_keys
       WHERE org_id = $1
       ORDER BY created_at DESC`,
      [orgId],
    );

    return res.rows;
  }

  /**
   * Revokes an existing API key, disabling it and evicting cache.
   */
  static async revokeApiKey(keyId: string, orgId: string, revokedBy: string): Promise<void> {
    const checkRes = await query(`SELECT key_hash, org_id FROM api_keys WHERE id = $1`, [keyId]);
    if (checkRes.rowCount === 0) {
      throw new Error('API Key not found');
    }

    const keyRow = checkRes.rows[0];
    if (keyRow.org_id !== orgId) {
      throw new Error('Forbidden: API Key does not belong to your organization');
    }

    // Update DB
    await query(
      `UPDATE api_keys
       SET is_active = false,
           revoked_at = NOW(),
           revoked_by = $1
       WHERE id = $2`,
      [revokedBy, keyId],
    );

    // Evict Redis cache immediately
    const cacheKey = CacheKeys.apiKey(keyRow.key_hash);
    await cacheService.delete(cacheKey);

    // Log audit
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'API_KEY_REVOKED', 'api_keys', $3)`,
      [orgId, revokedBy, keyId],
    );

    logger.warn(`[ApiKeyService] API Key ${keyId} revoked by user ${revokedBy}`);
  }

  /**
   * Rotates an API Key, revoking the current and issuing a new one with same config.
   */
  static async rotateApiKey(
    keyId: string,
    orgId: string,
    userId: string,
  ): Promise<{ apiKey: ApiKey; plainKey: string }> {
    const checkRes = await query(
      `SELECT name, scopes, allowed_ips, rate_limit_override, expires_at 
       FROM api_keys 
       WHERE id = $1 AND org_id = $2`,
      [keyId, orgId],
    );

    if (checkRes.rowCount === 0) {
      throw new Error('API Key not found or belongs to another organization');
    }

    const oldKey = checkRes.rows[0];

    // Revoke old key
    await this.revokeApiKey(keyId, orgId, userId);

    // Create new key
    const newKeyResult = await this.createApiKey({
      orgId,
      createdBy: userId,
      name: oldKey.name,
      scopes: oldKey.scopes,
      allowedIps: oldKey.allowed_ips || undefined,
      expiresAt: oldKey.expires_at ? new Date(oldKey.expires_at) : undefined,
      rateLimitOverride: oldKey.rate_limit_override || undefined,
    });

    // Log rotation audit
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'API_KEY_ROTATED', 'api_keys', $3)`,
      [orgId, userId, newKeyResult.apiKey.id],
    );

    logger.info(
      `[ApiKeyService] API Key rotated successfully (Old: ${keyId}, New: ${newKeyResult.apiKey.id})`,
    );

    return newKeyResult;
  }
}
export default ApiKeyService;
