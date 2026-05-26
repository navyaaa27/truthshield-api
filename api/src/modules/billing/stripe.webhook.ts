import express, { Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { query } from '../../shared/database/pool.js';
import { logger } from '../../utils/logger.js';
import { cacheService } from '../../shared/redis/cache.service.js';
import { CacheKeys } from '../../shared/redis/cache.keys.js';
import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { PLAN_LIMITS } from './billing.service.js';

const webhookRouter = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'ts_stripe_fake_secret', {
  apiVersion: '2023-10-16' as any,
});

async function sendEmail(recipient: string, subject: string, body: string): Promise<void> {
  try {
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST || 'localhost',
      port: env.SMTP_PORT || 587,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      } : undefined,
    });

    await transporter.sendMail({
      from: env.SMTP_FROM || 'alerts@truthshield.ai',
      to: recipient,
      subject,
      text: body,
    });
    logger.info(`[StripeWebhook] Email dispatched to ${recipient}: ${subject}`);
  } catch (err: any) {
    logger.error(`[StripeWebhook.sendEmail] Error: ${err.message}`);
  }
}

/**
 * Maps price ID back to plan tier string
 */
function getTierFromPriceId(priceId: string): string {
  if (priceId === process.env.STRIPE_GROWTH_PRICE_ID) return 'growth';
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) return 'pro';
  if (priceId === process.env.STRIPE_ENTERPRISE_PRICE_ID) return 'enterprise';
  return 'starter';
}

/**
 * Handles Webhook Events Asynchronously
 */
async function processWebhookEvent(event: any): Promise<void> {
  const stripeEventId = event.id;
  const eventType = event.type;

  logger.info(`[StripeWebhook] Processing event ID ${stripeEventId} (${eventType})`);

  // Parse Org ID from customer metadata if possible
  let customerId = '';
  if (typeof event.data.object === 'object' && 'customer' in event.data.object) {
    customerId = (event.data.object as any).customer;
  } else if (event.data.object && (event.data.object as any).id && event.data.object.object === 'customer') {
    customerId = (event.data.object as any).id;
  }

  let orgId = '';
  if (customerId) {
    const subRes = await query(`SELECT org_id FROM subscriptions WHERE stripe_customer_id = $1`, [customerId]);
    orgId = subRes.rows[0]?.org_id || '';
  }

  // 1. customer.subscription.updated
  if (eventType === 'customer.subscription.updated') {
    const stripeSub: any = event.data.object;
    const priceId = stripeSub.items.data[0]?.price.id;
    const planTier = getTierFromPriceId(priceId);
    const status = stripeSub.status;
    const periodStart = new Date(stripeSub.current_period_start * 1000);
    const periodEnd = new Date(stripeSub.current_period_end * 1000);
    const trialEnd = stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : null;
    const cancelAtPeriodEnd = stripeSub.cancel_at_period_end;

    if (orgId) {
      // Update subscription
      await query(
        `UPDATE subscriptions
         SET plan_tier = $1, status = $2, current_period_start = $3, current_period_end = $4,
             trial_end = $5, cancel_at_period_end = $6, updated_at = NOW()
         WHERE org_id = $7`,
        [planTier, status, periodStart, periodEnd, trialEnd, cancelAtPeriodEnd, orgId]
      );

      // Update org
      await query(`UPDATE organizations SET plan_tier = $1 WHERE id = $2`, [planTier, orgId]);

      // Update usage_records limit
      const limits = PLAN_LIMITS[planTier.toLowerCase()] || PLAN_LIMITS.starter;
      await query(
        `UPDATE usage_records
         SET jobs_limit = $1
         WHERE org_id = $2 AND period_start <= NOW() AND period_end >= NOW()`,
        [limits.jobs, orgId]
      );

      // Invalidate caches
      await cacheService.delete(CacheKeys.orgProfile(orgId));
      logger.info(`[StripeWebhook] Subscription updated for Org ${orgId}`);
    }
  }

  // 2. customer.subscription.deleted
  if (eventType === 'customer.subscription.deleted') {
    if (orgId) {
      await query(
        `UPDATE subscriptions
         SET status = 'canceled', plan_tier = 'starter', cancel_at_period_end = false, updated_at = NOW()
         WHERE org_id = $1`,
        [orgId]
      );

      await query(`UPDATE organizations SET plan_tier = 'starter' WHERE id = $1`, [orgId]);
      await cacheService.delete(CacheKeys.orgProfile(orgId));

      // Send cancellation email
      const orgRes = await query(`SELECT name, source_metadata FROM organizations WHERE id = $1`, [orgId]);
      const emailRecipient = orgRes.rows[0]?.source_metadata?.notifications?.emailRecipient || `billing+${orgId}@truthshield.ai`;
      await sendEmail(
        emailRecipient,
        `[TruthShield] Subscription Canceled`,
        `Your subscription has been canceled. Your account has been downgraded to the Starter tier.`
      );
    }
  }

  // 3. invoice.payment_succeeded
  if (eventType === 'invoice.payment_succeeded') {
    if (orgId) {
      const invoice: any = event.data.object;
      const stripeSubId = invoice.subscription as string;

      await query(
        `UPDATE subscriptions
         SET status = 'active', updated_at = NOW()
         WHERE org_id = $1`,
        [orgId]
      );

      // Reset usage counters by creating a new usage_record
      if (stripeSubId) {
        try {
          const stripeSub: any = await stripe.subscriptions.retrieve(stripeSubId);
          const periodStart = new Date(stripeSub.current_period_start * 1000);
          const periodEnd = new Date(stripeSub.current_period_end * 1000);
          const planTier = getTierFromPriceId(stripeSub.items.data[0]?.price.id);
          const limits = PLAN_LIMITS[planTier.toLowerCase()] || PLAN_LIMITS.starter;

          // Check if usage record already exists for the new period
          const exists = await query(`SELECT id FROM usage_records WHERE org_id = $1 AND period_start = $2`, [orgId, periodStart]);
          if (!exists.rowCount || exists.rowCount === 0) {
            await query(
              `INSERT INTO usage_records (org_id, period_start, period_end, jobs_limit)
               VALUES ($1, $2, $3, $4)`,
              [orgId, periodStart, periodEnd, limits.jobs]
            );
          }
        } catch (subErr: any) {
          logger.error(`[StripeWebhook] Failed to retrieve subscription for usage reset: ${subErr.message}`);
        }
      }

      const orgRes = await query(`SELECT name, source_metadata FROM organizations WHERE id = $1`, [orgId]);
      const emailRecipient = orgRes.rows[0]?.source_metadata?.notifications?.emailRecipient || `billing+${orgId}@truthshield.ai`;
      await sendEmail(
        emailRecipient,
        `[TruthShield] Payment Succeeded`,
        `Thank you for your payment. Your subscription remains fully active.`
      );
    }
  }

  // 4. invoice.payment_failed
  if (eventType === 'invoice.payment_failed') {
    if (orgId) {
      await query(
        `UPDATE subscriptions
         SET status = 'past_due', updated_at = NOW()
         WHERE org_id = $1`,
        [orgId]
      );

      // Check failure count (count of processed invoice.payment_failed events for this org)
      const countRes = await query(
        `SELECT COUNT(*) FROM billing_events
         WHERE org_id = $1 AND event_type = 'invoice.payment_failed' AND processed = true`,
        [orgId]
      );
      const totalFailures = parseInt(countRes.rows[0].count, 10) + 1; // including the current one

      const orgRes = await query(`SELECT name, source_metadata FROM organizations WHERE id = $1`, [orgId]);
      const emailRecipient = orgRes.rows[0]?.source_metadata?.notifications?.emailRecipient || `billing+${orgId}@truthshield.ai`;

      if (totalFailures >= 3) {
        // Suspend the account after 3 failures
        await query(`UPDATE organizations SET is_active = false WHERE id = $1`, [orgId]);
        await cacheService.delete(CacheKeys.orgProfile(orgId));

        await sendEmail(
          emailRecipient,
          `[TruthShield] Critical: Account Suspended Due to Non-Payment`,
          `Your subscription payment has failed 3 consecutive times. Your TruthShield account has been suspended.`
        );
      } else {
        await sendEmail(
          emailRecipient,
          `[TruthShield] Action Required: Payment Failed`,
          `Your payment has failed. Please update your billing info to prevent account suspension. Failure ${totalFailures}/3.`
        );
      }
    }
  }

  // 5. customer.subscription.trial_will_end
  if (eventType === 'customer.subscription.trial_will_end') {
    if (orgId) {
      const orgRes = await query(`SELECT name, source_metadata FROM organizations WHERE id = $1`, [orgId]);
      const emailRecipient = orgRes.rows[0]?.source_metadata?.notifications?.emailRecipient || `billing+${orgId}@truthshield.ai`;
      await sendEmail(
        emailRecipient,
        `[TruthShield] Notice: Trial ending in 3 days`,
        `Your trial subscription is concluding in 3 days. A paid billing cycle will begin automatically.`
      );
    }
  }

  // Mark event as processed
  await query(`UPDATE billing_events SET processed = true WHERE stripe_event_id = $1`, [stripeEventId]);
}

/**
 * POST /webhooks/stripe
 */
webhookRouter.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    const sig = req.headers['stripe-signature'] as string;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_fake_secret';

    let event: any;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err: any) {
      logger.error(`[StripeWebhook] Signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const stripeEventId = event.id;
    const eventType = event.type;

    try {
      const exists = await query(`SELECT processed FROM billing_events WHERE stripe_event_id = $1`, [stripeEventId]);
      if (exists.rowCount && exists.rowCount > 0) {
        logger.info(`[StripeWebhook] Event ${stripeEventId} already recorded. Skipping.`);
        return res.status(200).json({ received: true, duplicate: true });
      }

      // 2. Fetch Org ID from customer to link event
      let customerId = '';
      if (typeof event.data.object === 'object' && 'customer' in event.data.object) {
        customerId = (event.data.object as any).customer;
      } else if (event.data.object && (event.data.object as any).id && event.data.object.object === 'customer') {
        customerId = (event.data.object as any).id;
      }

      let orgId = null;
      if (customerId) {
        const subRes = await query(`SELECT org_id FROM subscriptions WHERE stripe_customer_id = $1`, [customerId]);
        orgId = subRes.rows[0]?.org_id || null;
      }

      // 3. Store raw event in database
      await query(
        `INSERT INTO billing_events (org_id, stripe_event_id, event_type, processed, payload)
         VALUES ($1, $2, $3, false, $4)`,
        [orgId, stripeEventId, eventType, JSON.stringify(event)]
      );

      // 4. Return success 200 immediately to Stripe
      res.status(200).json({ received: true });

      // 5. Process asynchronously in background
      processWebhookEvent(event).catch((err) => {
        logger.error(`[StripeWebhook.processWebhookEvent] Async processing failed: ${err.message}`);
        query(
          `UPDATE billing_events 
           SET error_message = $1 
           WHERE stripe_event_id = $2`,
          [err.message, stripeEventId]
        ).catch(() => {});
      });
    } catch (err: any) {
      next(err);
    }
  }
);

export { webhookRouter, processWebhookEvent };
