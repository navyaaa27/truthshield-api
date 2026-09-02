import { Resend } from 'resend';
import { IncomingWebhook } from '@slack/webhook';
import { query } from '../../shared/database/pool.js';
import { env } from '../../config/env.js';
import { Alert } from './alert.types.js';
import { logger } from '../../utils/logger.js';


export class NotificationService {
  /**
   * Dispatches alert notifications to configured organizational channels concurrently.
   */
  static async sendAlertNotifications(alert: Alert, org: any): Promise<void> {
    const metadata = org.source_metadata || {};
    const channels = metadata.notifications?.channels || ['email', 'slack'];

    const tasks: Promise<string>[] = [];

    if (channels.includes('email')) {
      tasks.push(this.sendEmailNotification(alert, org).then(() => 'email'));
    }

    if (channels.includes('slack')) {
      tasks.push(this.sendSlackNotification(alert, org).then(() => 'slack'));
    }

    if (tasks.length === 0) {
      logger.info(`No active notification channels configured for Organization: ${org.id}`);
      return;
    }

    const results = await Promise.allSettled(tasks);
    const successfulChannels: string[] = [];

    results.forEach((res) => {
      if (res.status === 'fulfilled') {
        successfulChannels.push(res.value);
      } else {
        logger.error(
          `Notification channel failed to dispatch: ${res.reason?.message || res.reason}`,
        );
      }
    });

    if (successfulChannels.length > 0) {
      await this.updateNotificationStatus(alert.id, successfulChannels);
    }
  }

  /**
   * Updates database state when notification dispatches complete.
   */
  static async updateNotificationStatus(alertId: string, channels: string[]): Promise<void> {
    await query(
      `UPDATE alerts 
       SET notification_sent = true, 
           notification_channels = $1, 
           updated_at = NOW() 
       WHERE id = $2`,
      [channels, alertId],
    );
    logger.info(
      `Updated notification state for Alert ${alertId} (Channels: ${channels.join(', ')})`,
    );
  }

  /**
   * Dispatches HTML email alerts using Resend.
   */
  private static async sendEmailNotification(alert: Alert, org: any): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      logger.warn('RESEND_API_KEY is not configured. Skipping email alert dispatch.');
      return;
    }

    const metadata = org.source_metadata || {};
    const recipient =
      metadata.notifications?.emailRecipient ||
      org.contactEmail ||
      org.email ||
      'alerts@truthshield.ai';

    try {
      const resend = new Resend(apiKey);
      await resend.emails.send({
        from: env.SMTP_FROM || 'alerts@truthshield.ai',
        to: recipient,
        subject: `[TruthShield] ${alert.severity.toUpperCase()} Alert: ${alert.title}`,
        html: buildAlertEmailHtml(alert),
      });
      logger.info(`Email alert notification successfully dispatched via Resend to: ${recipient}`);
    } catch (error) {
      logger.error('Email notification failed', { error });
    }
  }


  /**
   * Dispatches rich Slack Block Kit block payloads using IncomingWebhook.
   */
  private static async sendSlackNotification(alert: Alert, org: any): Promise<void> {
    const metadata = org.source_metadata || {};
    const webhookUrl = metadata.notifications?.slackWebhookUrl || env.SLACK_WEBHOOK_URL;

    if (!webhookUrl) {
      throw new Error('Slack webhook URL is not configured for this organization');
    }

    const webhook = new IncomingWebhook(webhookUrl);

    let emoji = '⚠️';
    if (alert.severity === 'critical') emoji = '🚨';
    if (alert.severity === 'high') emoji = '🔴';
    if (alert.severity === 'medium') emoji = '🟡';
    if (alert.severity === 'low') emoji = '🔵';

    const dashboardLink = `https://dashboard.truthshield.ai/jobs/${alert.job_id}`;

    await webhook.send({
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `${emoji} [${alert.severity.toUpperCase()}] TruthShield Alert`,
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Title*: ${alert.title}\n*Summary*: ${alert.summary}`,
          },
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Job ID*:\n${alert.job_id}`,
            },
            {
              type: 'mrkdwn',
              text: `*Severity*:\n${alert.severity.toUpperCase()}`,
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'View in Dashboard',
                emoji: true,
              },
              value: 'view_job',
              url: dashboardLink,
              action_id: 'button-action',
            },
          ],
        },
      ],
    });

    logger.info(`Slack alert notification blocks posted successfully`);
  }
}

function buildAlertEmailHtml(alert: Alert): string {
  const severityUpper = alert.severity.toUpperCase();
  const dashboardLink = `https://dashboard.truthshield.ai/jobs/${alert.job_id}`;
  return `
<div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
  <h2 style="color: #d9534f;">TruthShield Security Alert</h2>
  <hr />
  <p><strong>Severity:</strong> <span style="background: #f0ad4e; color: #fff; padding: 3px 6px; border-radius: 3px;">${severityUpper}</span></p>
  <p><strong>Title:</strong> ${alert.title}</p>
  <p><strong>Summary:</strong> ${alert.summary}</p>
  <p><strong>Job ID:</strong> ${alert.job_id}</p>
  <p><a href="${dashboardLink}" style="display: inline-block; padding: 10px 20px; background: #0275d8; color: #fff; text-decoration: none; border-radius: 4px;">View in Dashboard</a></p>
</div>
  `;
}
