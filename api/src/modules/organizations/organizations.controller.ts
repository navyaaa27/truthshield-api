import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { OrganizationsService } from './organizations.service.js';

export const createOrgSchema = z.object({
  name: z.string().min(2).max(100),
  domain: z.string().min(3).max(100),
});

export const updateOrgSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  domain: z.string().min(3).max(100).optional(),
});

export class OrganizationsController {
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const org = await OrganizationsService.create(req.body);
      res.status(201).json({
        status: 'success',
        data: { organization: org },
      });
    } catch (error) {
      next(error);
    }
  }

  static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const org = await OrganizationsService.findById(id);
      res.status(200).json({
        status: 'success',
        data: { organization: org },
      });
    } catch (error) {
      next(error);
    }
  }

  static async list(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const list = await OrganizationsService.listAll();
      res.status(200).json({
        status: 'success',
        data: { organizations: list },
      });
    } catch (error) {
      next(error);
    }
  }

  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const org = await OrganizationsService.update(id, req.body);
      res.status(200).json({
        status: 'success',
        data: { organization: org },
      });
    } catch (error) {
      next(error);
    }
  }

  static async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      await OrganizationsService.delete(id);
      res.status(200).json({
        status: 'success',
        message: 'Organization deleted successfully.',
      });
    } catch (error) {
      next(error);
    }
  }
}
