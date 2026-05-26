import { Socket } from 'socket.io';
import { getIO } from './socket.server.js';
import { query } from '../database/pool.js';
import { logger } from '../../utils/logger.js';

export interface JobStatusUpdate {
  status: string;
  progress?: number;
  completedModules?: string[];
  aggregatedScore?: number;
  aggregatedVerdict?: string;
}

export class SocketEmitter {
  emitJobUpdate(orgId: string, jobId: string, update: JobStatusUpdate): void {
    try {
      const io = getIO();
      const payload = {
        jobId,
        status: update.status,
        progress: update.progress,
        completedModules: update.completedModules,
        aggregatedScore: update.aggregatedScore,
        aggregatedVerdict: update.aggregatedVerdict,
        timestamp: new Date().toISOString(),
      };
      io.to(`org:${orgId}`).to(`job:${jobId}`).emit('job:update', payload);
    } catch (err: any) {
      logger.warn(`Failed to emit job update: ${err.message}`);
    }
  }

  emitNewAlert(orgId: string, alert: any): void {
    try {
      const io = getIO();
      const payload = {
        alertId: alert.id || alert.alertId,
        severity: alert.severity,
        title: alert.title,
        jobId: alert.job_id || alert.jobId,
        module: alert.module || 'unknown',
        score: alert.score || 0,
        timestamp: new Date().toISOString(),
      };
      io.to(`org:${orgId}`).emit('alert:new', payload);
    } catch (err: any) {
      logger.warn(`Failed to emit new alert: ${err.message}`);
    }
  }

  emitAlertUpdate(orgId: string, alertId: string, update: any): void {
    try {
      const io = getIO();
      const payload = {
        alertId,
        acknowledged: update.acknowledged_by || update.acknowledged_at ? true : false,
        resolved: update.resolved_by || update.resolved_at ? true : false,
        timestamp: new Date().toISOString(),
      };
      io.to(`org:${orgId}`).emit('alert:update', payload);
    } catch (err: any) {
      logger.warn(`Failed to emit alert update: ${err.message}`);
    }
  }

  emitReviewAssigned(userId: string, review: any): void {
    try {
      const io = getIO();
      const payload = {
        reviewId: review.id,
        jobId: review.job_id || review.jobId,
        priority: review.priority,
        slaDeadline: review.sla_deadline ? new Date(review.sla_deadline).toISOString() : null,
      };
      io.to(`user:${userId}`).emit('review:assigned', payload);
    } catch (err: any) {
      logger.warn(`Failed to emit review assignment: ${err.message}`);
    }
  }

  emitDashboardRefresh(orgId: string): void {
    try {
      const io = getIO();
      io.to(`org:${orgId}`).emit('dashboard:refresh', { timestamp: new Date().toISOString() });
    } catch (err: any) {
      logger.warn(`Failed to emit dashboard refresh: ${err.message}`);
    }
  }

  async emitUnreadAlertCount(socket: Socket | null, orgId: string): Promise<void> {
    try {
      const res = await query(
        'SELECT COUNT(*)::int as count FROM alerts WHERE org_id = $1 AND acknowledged_at IS NULL',
        [orgId]
      );
      const count = res.rows[0]?.count || 0;
      if (socket) {
        socket.emit('alerts:unread_count', { count });
      } else {
        const io = getIO();
        io.to(`org:${orgId}`).emit('alerts:unread_count', { count });
      }
    } catch (err: any) {
      logger.error(`Failed to emit unread alert count: ${err.message}`);
    }
  }
}

export const socketEmitter = new SocketEmitter();
