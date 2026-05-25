import { AppError } from '../../middleware/error.js';
import { query } from '../../shared/database/index.js';
import { logger } from '../../utils/logger.js';

export interface CreateOrgInput {
  name: string;
  domain: string;
}

export interface UpdateOrgInput {
  name?: string;
  domain?: string;
}

export class OrganizationsService {
  static async create(input: CreateOrgInput) {
    // Check if domain is already registered
    const domainCheck = await query('SELECT id FROM organizations WHERE domain = $1', [
      input.domain,
    ]);
    if (domainCheck.rowCount && domainCheck.rowCount > 0) {
      throw new AppError('An organization with this domain already exists', 400);
    }

    const res = await query(
      `INSERT INTO organizations (name, domain) 
       VALUES ($1, $2) 
       RETURNING id, name, domain, created_at, updated_at`,
      [input.name, input.domain],
    );

    const org = res.rows[0];
    logger.info(`Organization created: ${org.name} (${org.id})`);
    return org;
  }

  static async findById(id: string) {
    const res = await query('SELECT * FROM organizations WHERE id = $1', [id]);
    const org = res.rows[0];
    if (!org) {
      throw new AppError('Organization not found', 404);
    }
    return org;
  }

  static async listAll() {
    const res = await query(
      'SELECT id, name, domain, created_at FROM organizations ORDER BY created_at DESC',
    );
    return res.rows;
  }

  static async update(id: string, input: UpdateOrgInput) {
    // Verify organization exists
    await this.findById(id);

    if (input.domain) {
      const domainCheck = await query(
        'SELECT id FROM organizations WHERE domain = $1 AND id != $2',
        [input.domain, id],
      );
      if (domainCheck.rowCount && domainCheck.rowCount > 0) {
        throw new AppError('An organization with this domain already exists', 400);
      }
    }

    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (input.name) {
      fields.push(`name = $${paramIndex++}`);
      values.push(input.name);
    }

    if (input.domain) {
      fields.push(`domain = $${paramIndex++}`);
      values.push(input.domain);
    }

    if (fields.length === 0) {
      throw new AppError('No valid fields provided for update', 400);
    }

    values.push(id);
    const updateQuery = `
      UPDATE organizations 
      SET ${fields.join(', ')}, updated_at = NOW() 
      WHERE id = $${paramIndex} 
      RETURNING id, name, domain, created_at, updated_at
    `;

    const res = await query(updateQuery, values);
    logger.info(`Organization updated: ${id}`);
    return res.rows[0];
  }

  static async delete(id: string) {
    await this.findById(id);
    await query('DELETE FROM organizations WHERE id = $1', [id]);
    logger.info(`Organization deleted: ${id}`);
    return { success: true };
  }
}
