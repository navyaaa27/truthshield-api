import { Router, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { BillingService } from './billing.service.js';
import { UsageService } from './usage.service.js';
import { query } from '../../shared/database/pool.js';
import { webhookRouter } from './stripe.webhook.js';

const router = Router();
const isBillingEnabled = process.env.BILLING_ENABLED !== 'false';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'ts_stripe_fake_secret', {
  apiVersion: '2023-10-16' as any,
});

// 1. Stripe Webhook (unauthenticated, requires raw body)
// We expose it here so it can be resolved at /api/v1/webhooks/stripe
router.use('/webhooks', webhookRouter);

// 2. Authenticated billing endpoints (JWT only)
router.use('/billing', authenticate);

/**
 * GET /billing/subscription
 * Returns current subscription details + current period usage summary
 */
router.get('/billing/subscription', async (req: any, res: Response, next: NextFunction): Promise<void> => {
  try {
    const orgId = req.user.orgId || req.user.organizationId;
    const subscription = await BillingService.getSubscription(orgId);
    res.status(200).json({ subscription });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /billing/usage
 * Returns current period usage summary
 */
router.get('/billing/usage', async (req: any, res: Response, next: NextFunction): Promise<void> => {
  try {
    const orgId = req.user.orgId || req.user.organizationId;
    const usage = await UsageService.getCurrentPeriodUsage(orgId);
    res.status(200).json({ usage });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /billing/subscribe
 * Creates Stripe customer and new subscription (Admin Only)
 */
router.post('/billing/subscribe', authorize('admin'), async (req: any, res: Response, next: NextFunction): Promise<void> => {
  try {
    const orgId = req.user.orgId || req.user.organizationId;
    const { planTier, trialDays } = req.body;

    if (!planTier) {
      res.status(400).json({ error: 'Bad Request', message: 'planTier is a required property' });
      return;
    }

    const data = await BillingService.createSubscription({
      orgId,
      planTier,
      trialDays: trialDays ? parseInt(trialDays, 10) : undefined,
    });

    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /billing/upgrade
 * Upgrades or downgrades plan tier (Admin Only)
 */
router.post('/billing/upgrade', authorize('admin'), async (req: any, res: Response, next: NextFunction): Promise<void> => {
  try {
    const orgId = req.user.orgId || req.user.organizationId;
    const { newPlanTier } = req.body;

    if (!newPlanTier) {
      res.status(400).json({ error: 'Bad Request', message: 'newPlanTier is a required property' });
      return;
    }

    const subscription = await BillingService.updateSubscription(orgId, newPlanTier);
    res.status(200).json({ subscription });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /billing/cancel
 * Cancels active subscription (Admin Only)
 */
router.post('/billing/cancel', authorize('admin'), async (req: any, res: Response, next: NextFunction): Promise<void> => {
  try {
    const orgId = req.user.orgId || req.user.organizationId;
    const { immediately } = req.body;

    const subscription = await BillingService.cancelSubscription(orgId, !!immediately);
    res.status(200).json({ subscription });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /billing/invoices
 * Lists the last 12 customer invoices from Stripe
 */
router.get('/billing/invoices', async (req: any, res: Response, next: NextFunction): Promise<void> => {
  try {
    const orgId = req.user.orgId || req.user.organizationId;

    const subRes = await query(`SELECT stripe_customer_id FROM subscriptions WHERE org_id = $1`, [orgId]);
    const customerId = subRes.rows[0]?.stripe_customer_id;

    if (!isBillingEnabled || !customerId || customerId.startsWith('cus_fake_')) {
      res.status(200).json({ invoices: [] });
      return;
    }

    const stripeInvoices = await stripe.invoices.list({
      customer: customerId,
      limit: 12,
    });

    const formatted = stripeInvoices.data.map((inv) => ({
      id: inv.id,
      amount_due: inv.amount_due,
      amount_paid: inv.amount_paid,
      status: inv.status,
      hosted_invoice_url: inv.hosted_invoice_url,
      invoice_pdf: inv.invoice_pdf,
      created: inv.created,
    }));

    res.status(200).json({ invoices: formatted });
  } catch (err) {
    next(err);
  }
});

export default router;
