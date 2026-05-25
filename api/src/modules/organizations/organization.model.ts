import { query } from '../../shared/database/pool.js';
import { Organization } from './organization.types.js';

/**
 * Inserts a new organization record.
 */
export async function createOrganization(name: string, planTier: string): Promise<Organization> {
  const res = await query<Organization>(
    `INSERT INTO organizations (name, plan_tier)
     VALUES ($1, $2)
     RETURNING id, name, plan_tier, api_key_hash, is_active, created_at, updated_at`,
    [name, planTier],
  );
  return res.rows[0];
}

/**
 * Fetches an organization by its UUID.
 */
export async function getOrganizationById(id: string): Promise<Organization | null> {
  const res = await query<Organization>(
    `SELECT id, name, plan_tier, api_key_hash, is_active, created_at, updated_at
     FROM organizations
     WHERE id = $1`,
    [id],
  );
  return res.rows[0] || null;
}

/**
 * Fetches an organization using its SHA-256 API key hash.
 */
export async function getOrganizationByApiKeyHash(hash: string): Promise<Organization | null> {
  const res = await query<Organization>(
    `SELECT id, name, plan_tier, api_key_hash, is_active, created_at, updated_at
     FROM organizations
     WHERE api_key_hash = $1`,
    [hash],
  );
  return res.rows[0] || null;
}

/**
 * Updates columns dynamically on an organization.
 */
export async function updateOrganization(
  id: string,
  updates: Partial<Organization>,
): Promise<Organization> {
  const fields: string[] = [];
  const values: any[] = [];
  let idx = 1;

  for (const [key, val] of Object.entries(updates)) {
    if (['name', 'plan_tier', 'api_key_hash', 'is_active'].includes(key)) {
      fields.push(`${key} = $${idx++}`);
      values.push(val);
    }
  }

  if (fields.length === 0) {
    throw new Error('No valid fields provided for update');
  }

  values.push(id);
  const sql = `
    UPDATE organizations
    SET ${fields.join(', ')}, updated_at = NOW()
    WHERE id = $${idx}
    RETURNING id, name, plan_tier, api_key_hash, is_active, created_at, updated_at
  `;

  const res = await query<Organization>(sql, values);
  if (!res.rows[0]) {
    throw new Error('Organization not found');
  }
  return res.rows[0];
}

/**
 * Performs a soft-delete on an organization by setting is_active = false.
 */
export async function deactivateOrganization(id: string): Promise<void> {
  await query(
    `UPDATE organizations
     SET is_active = false, updated_at = NOW()
     WHERE id = $1`,
    [id],
  );
}
