import Stripe from 'stripe';
import { query } from '../../shared/database/pool.js';
import { Organization } from '../organizations/organization.types.js';
import { logger } from '../../utils/logger.js';
import { CacheKeys } from '../../shared/redis/cache.keys.js';
import { cacheService } from '../../shared/redis/cache.service.js';

const getBillingEnabled = () => process.env.BILLING_ENABLED !== 'false';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'ts_stripe_fake_secret', {
  apiVersion: '2023-10-16' as any,
});

export interface Subscription {
  id: string;
  org_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan_tier: string;
  status: string;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  trial_end: Date | null;
  seats_included: number;
  seats_used: number;
  monthly_retainer_usd: number | null;
  created_at: Date;
  updated_at: Date;
  daysRemaining?: number;
  usage?: any;
}

export const PLAN_LIMITS: Record<string, { jobs: number; uploads: number }> = {
  starter: { jobs: 100, uploads: 500 },
  growth: { jobs: 1000, uploads: 5000 },
  pro: { jobs: 10000, uploads: 50000 },
  enterprise: { jobs: 100000, uploads: 500000 },
};

export const PLAN_WEIGHTS: Record<string, number> = {
  starter: 1,
  growth: 2,
  pro: 3,
  enterprise: 4,
};

export class BillingService {
  /**
   * Helper to retrieve Stripe price ID from plan tier
   */
  static getPriceIdFromTier(planTier: string): string {
    const tier = planTier.toLowerCase();
    if (tier === 'starter') return process.env.STRIPE_STARTER_PRICE_ID || 'price_starter_fake';
    if (tier === 'growth') return process.env.STRIPE_GROWTH_PRICE_ID || 'price_growth_fake';
    if (tier === 'pro') return process.env.STRIPE_PRO_PRICE_ID || 'price_pro_fake';
    if (tier === 'enterprise') return process.env.STRIPE_ENTERPRISE_PRICE_ID || 'price_enterprise_fake';
    throw new Error(`Unknown plan tier: ${planTier}`);
  }

  /**
   * Creates a Stripe customer for the organization and updates subscriptions table
   */
  static async createCustomer(org: Organization): Promise<string> {
    let stripeCustomerId = `cus_fake_${org.id}`;

    if (getBillingEnabled()) {
      try {
        const customer = await stripe.customers.create({
          name: org.name,
          email: org.api_key_hash ? undefined : `billing+${org.id}@truthshield.ai`,
          metadata: { orgId: org.id },
        });
        stripeCustomerId = customer.id;
      } catch (err: any) {
        logger.error(`[BillingService.createCustomer] Stripe Error: ${err.message}`);
        throw err;
      }
    }

    await query(
      `INSERT INTO subscriptions (org_id, stripe_customer_id, plan_tier, status)
       VALUES ($1, $2, 'starter', 'active')
       ON CONFLICT (org_id) 
       DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id
       RETURNING stripe_customer_id`,
      [org.id, stripeCustomerId]
    );

    logger.info(`[BillingService.createCustomer] Customer registered for Org ${org.id}: ${stripeCustomerId}`);
    return stripeCustomerId;
  }

  /**
   * Subscribes an organization to a plan tier (handles trial setup and usage record initialization)
   */
  static async createSubscription(params: {
    orgId: string;
    planTier: string;
    trialDays?: number;
  }): Promise<{
    subscriptionId: string;
    clientSecret: string;
  }> {
    const { orgId, planTier, trialDays } = params;

    // 1. Fetch stripe customer ID or create customer
    const subRes = await query(`SELECT stripe_customer_id FROM subscriptions WHERE org_id = $1`, [orgId]);
    let customerId = subRes.rows[0]?.stripe_customer_id;

    if (!customerId) {
      const orgRes = await query(`SELECT * FROM organizations WHERE id = $1`, [orgId]);
      if (orgRes.rowCount === 0) {
        throw new Error(`Organization ${orgId} not found`);
      }
      customerId = await this.createCustomer(orgRes.rows[0]);
    }

    const priceId = this.getPriceIdFromTier(planTier);
    let subscriptionId = `sub_fake_${crypto.randomUUID()}`;
    let clientSecret = `seti_fake_secret_${crypto.randomUUID()}`;
    let currentPeriodStart = new Date();
    let currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days default
    let status = trialDays && trialDays > 0 ? 'trialing' : 'active';
    let trialEnd: Date | null = trialDays && trialDays > 0 ? new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000) : null;

    if (getBillingEnabled()) {
      try {
        const stripeSub: any = await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: priceId }],
          trial_period_days: trialDays && trialDays > 0 ? trialDays : undefined,
          payment_behavior: 'default_incomplete',
          payment_settings: { save_default_payment_method: 'on_subscription' },
          expand: ['latest_invoice.payment_intent'],
        });

        subscriptionId = stripeSub.id;
        currentPeriodStart = new Date(stripeSub.current_period_start * 1000);
        currentPeriodEnd = new Date(stripeSub.current_period_end * 1000);
        status = stripeSub.status;
        trialEnd = stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : null;

        const paymentIntent = (stripeSub.latest_invoice as any)?.payment_intent;
        clientSecret = paymentIntent?.client_secret || '';
      } catch (err: any) {
        logger.error(`[BillingService.createSubscription] Stripe Error: ${err.message}`);
        throw err;
      }
    }

    // 2. Persist local subscription
    await query(
      `INSERT INTO subscriptions (
        org_id, stripe_customer_id, stripe_subscription_id, plan_tier, status,
        current_period_start, current_period_end, trial_end, cancel_at_period_end, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, NOW())
      ON CONFLICT (org_id)
      DO UPDATE SET
        stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        plan_tier = EXCLUDED.plan_tier,
        status = EXCLUDED.status,
        current_period_start = EXCLUDED.current_period_start,
        current_period_end = EXCLUDED.current_period_end,
        trial_end = EXCLUDED.trial_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        updated_at = NOW()`,
      [orgId, customerId, subscriptionId, planTier, status, currentPeriodStart, currentPeriodEnd, trialEnd]
    );

    // 3. Update Org plan_tier
    await query(`UPDATE organizations SET plan_tier = $1 WHERE id = $2`, [planTier, orgId]);

    // 4. Initialize usage_record
    const limits = PLAN_LIMITS[planTier.toLowerCase()] || PLAN_LIMITS.starter;
    await query(
      `INSERT INTO usage_records (org_id, period_start, period_end, jobs_limit)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [orgId, currentPeriodStart, currentPeriodEnd, limits.jobs]
    );

    // 5. Invalidate caches
    await cacheService.delete(CacheKeys.orgProfile(orgId));

    logger.info(`[BillingService.createSubscription] Subscription created for Org ${orgId} to plan ${planTier}`);
    return { subscriptionId, clientSecret };
  }

  /**
   * Upgrades or downgrades an organization's subscription tier
   */
  static async updateSubscription(orgId: string, newPlanTier: string): Promise<Subscription> {
    const subRes = await query(`SELECT * FROM subscriptions WHERE org_id = $1`, [orgId]);
    if (subRes.rowCount === 0) {
      throw new Error(`Subscription record not found for Org ${orgId}`);
    }

    const subRow = subRes.rows[0];
    const oldPlanTier = subRow.plan_tier;
    const priceId = this.getPriceIdFromTier(newPlanTier);

    if (getBillingEnabled() && subRow.stripe_subscription_id) {
      try {
        const stripeSub = await stripe.subscriptions.retrieve(subRow.stripe_subscription_id);
        const itemId = stripeSub.items.data[0]?.id;

        if (itemId) {
          await stripe.subscriptions.update(subRow.stripe_subscription_id, {
            proration_behavior: 'always_invoice',
            items: [{
              id: itemId,
              price: priceId,
            }],
          });
        }
      } catch (err: any) {
        logger.error(`[BillingService.updateSubscription] Stripe Error: ${err.message}`);
        throw err;
      }
    }

    // Update database record
    const updateRes = await query(
      `UPDATE subscriptions
       SET plan_tier = $1,
           updated_at = NOW()
       WHERE org_id = $2
       RETURNING *`,
      [newPlanTier, orgId]
    );

    // Update organization plan_tier
    await query(`UPDATE organizations SET plan_tier = $1 WHERE id = $2`, [newPlanTier, orgId]);

    // Update usage_records limit for current period
    const limits = PLAN_LIMITS[newPlanTier.toLowerCase()] || PLAN_LIMITS.starter;
    await query(
      `UPDATE usage_records
       SET jobs_limit = $1
       WHERE org_id = $2 AND period_start <= NOW() AND period_end >= NOW()`,
      [limits.jobs, orgId]
    );

    // Invalidate caches
    await cacheService.delete(CacheKeys.orgProfile(orgId));

    // Audit log
    const oldWeight = PLAN_WEIGHTS[oldPlanTier.toLowerCase()] || 0;
    const newWeight = PLAN_WEIGHTS[newPlanTier.toLowerCase()] || 0;
    const action = newWeight >= oldWeight ? 'SUBSCRIPTION_UPGRADED' : 'SUBSCRIPTION_DOWNGRADED';

    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [orgId, '00000000-0000-0000-0000-000000000000', action, 'subscriptions', subRow.id]
    );

    logger.info(`[BillingService.updateSubscription] Org ${orgId} moved from ${oldPlanTier} to ${newPlanTier}`);
    return updateRes.rows[0];
  }

  /**
   * Cancels a subscription immediately or schedules cancellation at the period end
   */
  static async cancelSubscription(orgId: string, immediately: boolean): Promise<Subscription> {
    const subRes = await query(`SELECT * FROM subscriptions WHERE org_id = $1`, [orgId]);
    if (subRes.rowCount === 0) {
      throw new Error(`Subscription record not found for Org ${orgId}`);
    }

    const subRow = subRes.rows[0];

    if (getBillingEnabled() && subRow.stripe_subscription_id) {
      try {
        if (immediately) {
          await stripe.subscriptions.cancel(subRow.stripe_subscription_id);
        } else {
          await stripe.subscriptions.update(subRow.stripe_subscription_id, {
            cancel_at_period_end: true,
          });
        }
      } catch (err: any) {
        logger.error(`[BillingService.cancelSubscription] Stripe Error: ${err.message}`);
        throw err;
      }
    }

    let updateRes;
    if (immediately) {
      updateRes = await query(
        `UPDATE subscriptions
         SET status = 'canceled',
             plan_tier = 'starter',
             cancel_at_period_end = false,
             updated_at = NOW()
         WHERE org_id = $1
         RETURNING *`,
        [orgId]
      );
      // Downgrade organization to starter
      await query(`UPDATE organizations SET plan_tier = 'starter' WHERE id = $1`, [orgId]);
    } else {
      updateRes = await query(
        `UPDATE subscriptions
         SET cancel_at_period_end = true,
             updated_at = NOW()
         WHERE org_id = $1
         RETURNING *`,
        [orgId]
      );
    }

    // Invalidate caches
    await cacheService.delete(CacheKeys.orgProfile(orgId));

    // Audit logs
    await query(
      `INSERT INTO audit_logs (org_id, user_id, action, resource_type, resource_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [orgId, '00000000-0000-0000-0000-000000000000', 'SUBSCRIPTION_CANCELED', 'subscriptions', subRow.id]
    );

    logger.info(`[BillingService.cancelSubscription] Canceled subscription for Org ${orgId} (immediately: ${immediately})`);
    return updateRes.rows[0];
  }

  /**
   * Fetches active subscription including remaining time and current period usage summary
   */
  static async getSubscription(orgId: string): Promise<Subscription | null> {
    const subRes = await query(`SELECT * FROM subscriptions WHERE org_id = $1`, [orgId]);
    if (subRes.rowCount === 0) {
      return null;
    }

    const sub = subRes.rows[0];
    const end = sub.current_period_end ? new Date(sub.current_period_end).getTime() : Date.now();
    const daysRemaining = Math.max(0, Math.ceil((end - Date.now()) / (24 * 60 * 60 * 1000)));

    // Fetch usage for current period
    const usageRes = await query(
      `SELECT * FROM usage_records
       WHERE org_id = $1 AND period_start <= NOW() AND period_end >= NOW()
       LIMIT 1`,
      [orgId]
    );

    return {
      ...sub,
      daysRemaining,
      usage: usageRes.rows[0] || null,
    };
  }
}
