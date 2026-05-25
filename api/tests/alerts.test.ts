/* eslint-disable @typescript-eslint/ban-ts-comment */
import request from 'supertest';
import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

// --- Multi-Channel Notification Dynamic Fail Flags ---
let emailFailFlag = false;
let slackFailFlag = false;

// Mock nodemailer
jest.mock('nodemailer', () => {
  return {
    createTransport: jest.fn().mockImplementation(() => {
      return {
        sendMail: jest.fn().mockImplementation(() => {
          if (emailFailFlag) {
            return Promise.reject(new Error('SMTP Transport Error'));
          }
          return Promise.resolve({ messageId: 'mock-email-id-123' });
        }),
      };
    }),
  };
});

// Mock @slack/webhook
jest.mock('@slack/webhook', () => {
  return {
    IncomingWebhook: jest.fn().mockImplementation(() => {
      return {
        send: jest.fn().mockImplementation(() => {
          if (slackFailFlag) {
            return Promise.reject(new Error('Slack Webhook Error'));
          }
          return Promise.resolve({ text: 'ok' });
        }),
      };
    }),
  };
});

// --- High-Fidelity DB & Redis Mock State Store ---
let mockAlerts: any[] = [];
let mockDetectionResults: any[] = [];
let mockOrganizations: any[] = [];
let mockAuditLogs: any[] = [];
let mockRedisStore: Record<string, string> = {};

// Mock postgres pool & query
jest.mock('../src/shared/database/pool.js', () => {
  return {
    pool: {
      connect: jest.fn().mockImplementation(() =>
        Promise.resolve({
          query: jest.fn().mockImplementation(() => Promise.resolve({ rows: [], rowCount: 0 })),
          release: jest.fn(),
        }),
      ),
      end: jest.fn().mockImplementation(() => Promise.resolve()),
    },
    testConnection: jest.fn().mockImplementation(() => Promise.resolve()),
    query: jest.fn().mockImplementation(((text: any, params?: any[]) => {
      const sql = (text || '').trim().toLowerCase();
      const p = params || [];

      // 1. SELECT * FROM detection_results WHERE job_id = $1 AND org_id = $2
      if (sql.startsWith('select * from detection_results')) {
        const jobId = p[0];
        const orgId = p[1];
        const rows = mockDetectionResults.filter((r) => r.job_id === jobId && r.org_id === orgId);
        return Promise.resolve({ rows, rowCount: rows.length });
      }

      // 2. SELECT * FROM organizations WHERE id = $1
      if (sql.startsWith('select * from organizations')) {
        const id = p[0];
        const org = mockOrganizations.find((o) => o.id === id) || null;
        return Promise.resolve({ rows: org ? [org] : [], rowCount: org ? 1 : 0 });
      }

      // 3. SELECT * FROM alerts WHERE id = $1
      if (sql.startsWith('select * from alerts where id = $1')) {
        const id = p[0];
        const alert = mockAlerts.find((a) => a.id === id) || null;
        return Promise.resolve({ rows: alert ? [alert] : [], rowCount: alert ? 1 : 0 });
      }

      // 4. COUNT of unacknowledged alerts
      if (sql.includes('count(*)::int as count from alerts') && sql.includes('acknowledged_at is null')) {
        const orgId = p[0];
        const count = mockAlerts.filter((a) => a.org_id === orgId && !a.acknowledged_at).length;
        return Promise.resolve({ rows: [{ count }], rowCount: 1 });
      }

      // 5. COUNT of filtered alerts
      if (sql.startsWith('select count(*)::int') && sql.includes('from alerts')) {
        const orgId = p[0];
        let filtered = mockAlerts.filter((a) => a.org_id === orgId);

        const severityParam = p.find((val) => ['low', 'medium', 'high', 'critical'].includes(val));
        if (severityParam) {
          filtered = filtered.filter((a) => a.severity === severityParam);
        }

        if (sql.includes('acknowledged_at is not null')) {
          filtered = filtered.filter((a) => a.acknowledged_at !== null);
        } else if (sql.includes('acknowledged_at is null')) {
          filtered = filtered.filter((a) => a.acknowledged_at === null);
        }

        return Promise.resolve({ rows: [{ count: filtered.length }], rowCount: 1 });
      }

      // 6. SELECT paginated alerts
      if (sql.includes('select * from alerts') || sql.includes('select * from alerts where')) {
        const orgId = p[0];
        let filtered = mockAlerts.filter((a) => a.org_id === orgId);

        const severityParam = p.find((val) => ['low', 'medium', 'high', 'critical'].includes(val));
        if (severityParam) {
          filtered = filtered.filter((a) => a.severity === severityParam);
        }

        if (sql.includes('acknowledged_at is not null')) {
          filtered = filtered.filter((a) => a.acknowledged_at !== null);
        } else if (sql.includes('acknowledged_at is null')) {
          filtered = filtered.filter((a) => a.acknowledged_at === null);
        }

        // Sort DESC
        const sorted = [...filtered].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        
        // Grab limit and offset
        const limit = p[p.length - 2] || 10;
        const offset = p[p.length - 1] || 0;
        const paginated = sorted.slice(offset, offset + limit);

        return Promise.resolve({ rows: paginated, rowCount: paginated.length });
      }

      // 7. Aggregate stats from alerts
      if (sql.includes('count(case when severity =')) {
        const orgId = p[0];
        const orgAlerts = mockAlerts.filter((a) => a.org_id === orgId);

        const stats = {
          total: orgAlerts.length,
          low: orgAlerts.filter((a) => a.severity === 'low').length,
          medium: orgAlerts.filter((a) => a.severity === 'medium').length,
          high: orgAlerts.filter((a) => a.severity === 'high').length,
          critical: orgAlerts.filter((a) => a.severity === 'critical').length,
          unread: orgAlerts.filter((a) => !a.acknowledged_at).length,
        };

        return Promise.resolve({ rows: [stats], rowCount: 1 });
      }

      // 8. INSERT INTO alerts
      if (sql.startsWith('insert into alerts')) {
        const org_id = p[0];
        const result_id = p[1];
        const job_id = p[2];
        const severity = p[3];
        const title = p[4];
        const summary = p[5];
        const newAlert = {
          id: `alert-uuid-${Math.random().toString(36).substr(2, 9)}`,
          org_id,
          result_id,
          job_id,
          severity,
          title,
          summary,
          acknowledged_by: null,
          acknowledged_at: null,
          resolved_by: null,
          resolved_at: null,
          notification_sent: false,
          notification_channels: [],
          created_at: new Date(),
          updated_at: new Date(),
        };
        mockAlerts.push(newAlert);
        return Promise.resolve({ rows: [newAlert], rowCount: 1 });
      }

      // 9. UPDATE alerts (acknowledgement / resolution / notification status)
      if (sql.startsWith('update alerts')) {
        const id = p[p.length - 1];
        const alert = mockAlerts.find((a) => a.id === id);
        if (alert) {
          if (sql.includes('acknowledged_by = $1')) {
            alert.acknowledged_by = p[0];
            alert.acknowledged_at = new Date();
          } else if (sql.includes('resolved_by = $1')) {
            alert.resolved_by = p[0];
            alert.resolved_at = new Date();
          } else if (sql.includes('notification_sent = true')) {
            alert.notification_sent = true;
            alert.notification_channels = p[0];
          }
          alert.updated_at = new Date();
          return Promise.resolve({ rows: [alert], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // 10. INSERT INTO audit_logs
      if (sql.startsWith('insert into audit_logs')) {
        mockAuditLogs.push(p);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      return Promise.resolve({ rows: [], rowCount: 0 });
    }) as any),
  };
});

// Mock Redis
jest.mock('../src/shared/redis/index.js', () => {
  return {
    checkRedisHealth: jest.fn().mockImplementation(() => Promise.resolve(true)),
    redis: {
      get: jest.fn().mockImplementation(((key: any) => {
        return Promise.resolve(mockRedisStore[key] || null);
      }) as any),
      set: jest.fn().mockImplementation(((key: any, value: any, _mode?: any, _duration?: any) => {
        mockRedisStore[key] = value;
        return Promise.resolve('OK');
      }) as any),
      del: jest.fn().mockImplementation(((key: any) => {
        delete mockRedisStore[key];
        return Promise.resolve(1);
      }) as any),
    },
  };
});

// Load services & app to test
import { AlertService } from '../src/modules/alerts/alert.service.js';
import { NotificationService } from '../src/modules/alerts/notification.service.js';
import { app } from '../src/app.js';

describe('Alert Generation & Notification Service Suite', () => {
  const orgIdA = 'org-uuid-a';
  const orgIdB = 'org-uuid-b';
  const jobId = 'job-uuid-123';
  const userIdA = 'user-uuid-a';
  const userIdB = 'user-uuid-b';

  // JWT auth tokens
  const adminTokenA = jwt.sign({ userId: userIdA, orgId: orgIdA, role: 'admin' }, env.JWT_SECRET, { expiresIn: '15m' });
  const analystTokenA = jwt.sign({ userId: userIdA, orgId: orgIdA, role: 'analyst' }, env.JWT_SECRET, { expiresIn: '15m' });
  const userTokenA = jwt.sign({ userId: userIdA, orgId: orgIdA, role: 'user' }, env.JWT_SECRET, { expiresIn: '15m' });

  beforeEach(() => {
    mockAlerts = [];
    mockDetectionResults = [];
    mockAuditLogs = [];
    mockRedisStore = {};
    mockOrganizations = [
      {
        id: orgIdA,
        name: 'Org A',
        email: 'admin@orga.com',
        source_metadata: {
          notifications: {
            channels: ['email', 'slack'],
            emailRecipient: 'alerts@orga.com',
            slackWebhookUrl: 'https://hooks.slack.com/services/org-a-webhook',
          },
        },
      },
      {
        id: orgIdB,
        name: 'Org B',
        email: 'admin@orgb.com',
        source_metadata: {
          notifications: {
            channels: ['email'],
            emailRecipient: 'alerts@orgb.com',
          },
        },
      },
    ];
    emailFailFlag = false;
    slackFailFlag = false;
  });

  describe('Alert Generation Logic Checks', () => {
    it('generateAlerts creates correct severity for each score range', async () => {
      // Setup detection results covering all score ranges
      mockDetectionResults = [
        { id: 'res-1', job_id: jobId, org_id: orgIdA, module: 'deepfake', score: 30, verdict: 'suspicious' }, // Low (25-50)
        { id: 'res-2', job_id: jobId, org_id: orgIdA, module: 'fake_news', score: 60, verdict: 'suspicious' }, // Medium (51-75)
        { id: 'res-3', job_id: jobId, org_id: orgIdA, module: 'stolen_content', score: 80, verdict: 'manipulated' }, // High (76-90)
        { id: 'res-4', job_id: jobId, org_id: orgIdA, module: 'metadata_tampering', score: 95, verdict: 'manipulated' }, // Critical (91-100)
      ];

      const alerts = await AlertService.generateAlerts(jobId, orgIdA);

      expect(alerts).toHaveLength(4);
      expect(alerts.find((a) => a.result_id === 'res-1')?.severity).toBe('low');
      expect(alerts.find((a) => a.result_id === 'res-2')?.severity).toBe('medium');
      expect(alerts.find((a) => a.result_id === 'res-3')?.severity).toBe('high');
      expect(alerts.find((a) => a.result_id === 'res-4')?.severity).toBe('critical');

      // Check human-readable text generation
      const deepfakeAlert = alerts.find((a) => a.result_id === 'res-1');
      expect(deepfakeAlert?.title).toBe('Potential deepfake detected in uploaded media');
      expect(deepfakeAlert?.summary).toContain('30% probability of face or digital voice manipulation');
    });

    it('generateAlerts skips results with score < 25', async () => {
      mockDetectionResults = [
        { id: 'res-1', job_id: jobId, org_id: orgIdA, module: 'deepfake', score: 15, verdict: 'clean' },
        { id: 'res-2', job_id: jobId, org_id: orgIdA, module: 'metadata_tampering', score: 24, verdict: 'clean' },
      ];

      const alerts = await AlertService.generateAlerts(jobId, orgIdA);
      expect(alerts).toHaveLength(0);
    });
  });

  describe('Organization Isolation & Security Protections', () => {
    it('getAlerts enforces org isolation and lists alerts only for the target org', async () => {
      mockAlerts = [
        { id: 'alert-1', org_id: orgIdA, severity: 'low', title: 'Alert A1', created_at: new Date() },
        { id: 'alert-2', org_id: orgIdA, severity: 'medium', title: 'Alert A2', created_at: new Date() },
        { id: 'alert-3', org_id: orgIdB, severity: 'critical', title: 'Alert B1', created_at: new Date() },
      ];

      const resA = await AlertService.getAlerts(orgIdA, { page: 1, limit: 10 });
      expect(resA.alerts).toHaveLength(2);
      expect(resA.unreadCount).toBe(2);
      expect(resA.alerts.find((a) => a.id === 'alert-3')).toBeUndefined();

      const resB = await AlertService.getAlerts(orgIdB, { page: 1, limit: 10 });
      expect(resB.alerts).toHaveLength(1);
      expect(resB.alerts[0].title).toBe('Alert B1');
    });

    it('acknowledgeAlert by different org throws ForbiddenError', async () => {
      mockAlerts = [
        { id: 'alert-1', org_id: orgIdA, severity: 'medium', title: 'Alert A1', acknowledged_at: null },
      ];

      await expect(
        AlertService.acknowledgeAlert('alert-1', userIdB, orgIdB)
      ).rejects.toThrow('You do not have permission to access this alert');
    });
  });

  describe('Multi-Channel Notification Fault Tolerance', () => {
    it('sendEmailNotification failure does not throw (logs and attempts other channels)', async () => {
      const alert = {
        id: 'alert-123',
        org_id: orgIdA,
        result_id: 'res-1',
        job_id: jobId,
        severity: 'high' as const,
        title: 'Tampering Detected',
        summary: 'Re-compression match at 80%',
        acknowledged_by: null,
        acknowledged_at: null,
        resolved_by: null,
        resolved_at: null,
        notification_sent: false,
        notification_channels: [],
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockAlerts.push(alert);

      // Set email to fail, but Slack to pass
      emailFailFlag = true;
      slackFailFlag = false;

      // Executing must NOT throw
      await expect(
        NotificationService.sendAlertNotifications(alert, mockOrganizations[0])
      ).resolves.not.toThrow();

      // Verify that notification_channels contains 'slack' but NOT 'email' in the database
      const dbAlert = mockAlerts.find((a) => a.id === alert.id);
      expect(dbAlert.notification_sent).toBe(true);
      expect(dbAlert.notification_channels).toContain('slack');
      expect(dbAlert.notification_channels).not.toContain('email');
    });

    it('sendSlackNotification failure does not throw (logs and succeeds for email)', async () => {
      const alert = {
        id: 'alert-456',
        org_id: orgIdA,
        result_id: 'res-1',
        job_id: jobId,
        severity: 'critical' as const,
        title: 'Deepfake Found',
        summary: 'Splicing matched at 95%',
        acknowledged_by: null,
        acknowledged_at: null,
        resolved_by: null,
        resolved_at: null,
        notification_sent: false,
        notification_channels: [],
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockAlerts.push(alert);

      // Set Slack to fail, but email to pass
      emailFailFlag = false;
      slackFailFlag = true;

      await expect(
        NotificationService.sendAlertNotifications(alert, mockOrganizations[0])
      ).resolves.not.toThrow();

      const dbAlert = mockAlerts.find((a) => a.id === alert.id);
      expect(dbAlert.notification_sent).toBe(true);
      expect(dbAlert.notification_channels).toContain('email');
      expect(dbAlert.notification_channels).not.toContain('slack');
    });

    it('Promise.allSettled guarantees both channels are attempted even if one fails', async () => {
      const alert = {
        id: 'alert-789',
        org_id: orgIdA,
        result_id: 'res-1',
        job_id: jobId,
        severity: 'medium' as const,
        title: 'Alert Title',
        summary: 'Alert Summary',
        acknowledged_by: null,
        acknowledged_at: null,
        resolved_by: null,
        resolved_at: null,
        notification_sent: false,
        notification_channels: [],
        created_at: new Date(),
        updated_at: new Date(),
      };

      mockAlerts.push(alert);

      // Set BOTH to fail
      emailFailFlag = true;
      slackFailFlag = true;

      await expect(
        NotificationService.sendAlertNotifications(alert, mockOrganizations[0])
      ).resolves.not.toThrow();

      const dbAlert = mockAlerts.find((a) => a.id === alert.id);
      expect(dbAlert.notification_sent).toBe(false);
      expect(dbAlert.notification_channels).toHaveLength(0);
    });
  });

  describe('Express Router Alert Endpoints Integration Checks', () => {
    beforeEach(() => {
      mockAlerts = [
        { id: 'alert-a1', org_id: orgIdA, severity: 'low', title: 'Alert Low', acknowledged_at: null, created_at: new Date(Date.now() - 1000) },
        { id: 'alert-a2', org_id: orgIdA, severity: 'high', title: 'Alert High', acknowledged_at: null, created_at: new Date() },
      ];
    });

    it('GET /api/v1/alerts retrieves alerts lists and total counts', async () => {
      const res = await request(app)
        .get('/api/v1/alerts')
        .set('Authorization', `Bearer ${adminTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.alerts).toHaveLength(2);
      expect(res.body.total).toBe(2);
      expect(res.body.unreadCount).toBe(2);
    });

    it('PATCH /api/v1/alerts/:id/acknowledge lets any authenticated user acknowledge alert', async () => {
      const res = await request(app)
        .patch('/api/v1/alerts/alert-a1/acknowledge')
        .set('Authorization', `Bearer ${userTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.acknowledged_by).toBe(userIdA);
      expect(res.body.acknowledged_at).not.toBeNull();
    });

    it('PATCH /api/v1/alerts/:id/resolve requires analyst or admin role', async () => {
      // 1. Should fail for user role
      const failRes = await request(app)
        .patch('/api/v1/alerts/alert-a2/resolve')
        .set('Authorization', `Bearer ${userTokenA}`);

      expect(failRes.status).toBe(403);

      // 2. Should pass for analyst role
      const passRes = await request(app)
        .patch('/api/v1/alerts/alert-a2/resolve')
        .set('Authorization', `Bearer ${analystTokenA}`);

      expect(passRes.status).toBe(200);
      expect(passRes.body.resolved_by).toBe(userIdA);
      expect(passRes.body.resolved_at).not.toBeNull();
    });

    it('GET /api/v1/alerts/stats aggregates counts and caches in Redis', async () => {
      const cacheKey = `alert_stats:${orgIdA}`;

      // 1. Initially, cache is empty. Stats calculated from DB and cached.
      const res1 = await request(app)
        .get('/api/v1/alerts/stats')
        .set('Authorization', `Bearer ${adminTokenA}`);

      expect(res1.status).toBe(200);
      expect(res1.body.total).toBe(2);
      expect(res1.body.bySeverity.low).toBe(1);
      expect(res1.body.bySeverity.high).toBe(1);
      expect(res1.body.unread).toBe(2);

      // Verify stats are cached in Redis
      expect(mockRedisStore[cacheKey]).not.toBeNull();

      // 2. Subsequent call fetches directly from Redis cache
      mockAlerts = []; // clear DB to prove it is reading from cache
      const res2 = await request(app)
        .get('/api/v1/alerts/stats')
        .set('Authorization', `Bearer ${adminTokenA}`);

      expect(res2.status).toBe(200);
      expect(res2.body.total).toBe(2); // still reads the cached total of 2!
    });
  });
});
