import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { UsersService } from './users.service.js';

export const updateProfileSchema = z.object({
  email: z.string().email().optional(),
  role: z.enum(['user', 'admin']).optional(),
  organizationId: z.string().uuid().nullable().optional(),
});

export class UsersController {
  static async getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const profile = await UsersService.getProfile(userId);

      res.status(200).json({
        status: 'success',
        data: { user: profile },
      });
    } catch (error) {
      next(error);
    }
  }

  static async updateMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      // Normal users shouldn't be allowed to change their own role via /me
      const { email, organizationId } = req.body;
      const updated = await UsersService.updateProfile(userId, { email, organizationId });

      res.status(200).json({
        status: 'success',
        data: { user: updated },
      });
    } catch (error) {
      next(error);
    }
  }

  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { organizationId } = req.query;
      let users;

      if (organizationId) {
        users = await UsersService.listByOrganization(organizationId as string);
      } else {
        users = await UsersService.listAll();
      }

      res.status(200).json({
        status: 'success',
        data: { users },
      });
    } catch (error) {
      next(error);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const updated = await UsersService.updateProfile(id, req.body);

      res.status(200).json({
        status: 'success',
        data: { user: updated },
      });
    } catch (error) {
      next(error);
    }
  }
}
