import { AppError } from '../../middleware/error.js';
import { query } from '../../shared/database/index.js';
import { logger } from '../../utils/logger.js';

export interface UpdateUserProfileInput {
  email?: string;
  role?: string;
  organizationId?: string;
}

export class UsersService {
  static async getProfile(userId: string) {
    const res = await query(
      `SELECT id, email, role, organization_id, is_two_factor_enabled, created_at, updated_at 
       FROM users WHERE id = $1`,
      [userId],
    );

    const user = res.rows[0];
    if (!user) {
      throw new AppError('User profile not found', 404);
    }
    return user;
  }

  static async listAll() {
    const res = await query(
      `SELECT id, email, role, organization_id, is_two_factor_enabled, created_at 
       FROM users ORDER BY created_at DESC`,
    );
    return res.rows;
  }

  static async listByOrganization(organizationId: string) {
    const res = await query(
      `SELECT id, email, role, organization_id, is_two_factor_enabled, created_at 
       FROM users WHERE organization_id = $1 
       ORDER BY created_at DESC`,
      [organizationId],
    );
    return res.rows;
  }

  static async updateProfile(userId: string, input: UpdateUserProfileInput) {
    // Check if email already taken
    if (input.email) {
      const emailCheck = await query('SELECT id FROM users WHERE email = $1 AND id != $2', [
        input.email,
        userId,
      ]);
      if (emailCheck.rowCount && emailCheck.rowCount > 0) {
        throw new AppError('A user with this email address already exists', 400);
      }
    }

    // Check if organization exists
    if (input.organizationId) {
      const orgCheck = await query('SELECT id FROM organizations WHERE id = $1', [
        input.organizationId,
      ]);
      if (orgCheck.rowCount === 0) {
        throw new AppError('Organization not found', 404);
      }
    }

    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (input.email) {
      fields.push(`email = $${paramIndex++}`);
      values.push(input.email);
    }

    if (input.role) {
      fields.push(`role = $${paramIndex++}`);
      values.push(input.role);
    }

    if (input.organizationId !== undefined) {
      fields.push(`organization_id = $${paramIndex++}`);
      values.push(input.organizationId);
    }

    if (fields.length === 0) {
      throw new AppError('No changes provided for update', 400);
    }

    values.push(userId);
    const updateQuery = `
      UPDATE users 
      SET ${fields.join(', ')}, updated_at = NOW() 
      WHERE id = $${paramIndex} 
      RETURNING id, email, role, organization_id, is_two_factor_enabled, created_at, updated_at
    `;

    const res = await query(updateQuery, values);
    logger.info(`User profile updated: ${userId}`);
    return res.rows[0];
  }
}
