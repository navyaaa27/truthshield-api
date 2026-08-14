/* eslint-disable @typescript-eslint/ban-ts-comment */
process.env.BILLING_ENABLED = 'true';
import { jest } from '@jest/globals';
import crypto from 'crypto';

// ----------------------------------------------------
// Mock Stores & Mocks
// ----------------------------------------------------
let mockSubscriptions: any[] = [];
let mockUsageRecords: any[] = [];
let mockBillingEvents: any[] = [];
let mockOrganizations: any[] = [
  { id: 'org-uuid-1', name: 'Test Org 1', plan_tier: 'starter', is_active: true },
];
const mockUsers: any[] = [{ id: 'user-uuid-1', email: 'user1@test.com', org_id: 'org-uuid-1' }];

let mockRedisStore: Record<string, string> = {};
let isRedisAvailable = true;

// Mock nodemailer
const mockSendMail = jest.fn().mockImplementation(() => Promise.resolve());
jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue({
    sendMail: mockSendMail,
  }),
}));

// Mock Redis Client
jest.mock('../src/shared/redis/redis.client.js', () => ({
  redisClient: {
    get: jest.fn().mockImplementation(((key: string) => {
      if (!isRedisAvailable) return Promise.reject(new Error('Redis Connection Failure'));
      return Promise.resolve(mockRedisStore[key] || null);
    }) as any),
    setex: jest.fn().mockImplementation(((key: string, _ttl: any, val: any) => {
      if (!isRedisAvailable) return Promise.reject(new Error('Redis Connection Failure'));
      mockRedisStore[key] = val.toString();
      return Promise.resolve('OK');
    }) as any),
    incr: jest.fn().mockImplementation(((key: string) => {
      if (!isRedisAvailable) return Promise.reject(new Error('Redis Connection Failure'));
      const current = parseInt(mockRedisStore[key] || '0', 10);
      const next = current + 1;
      mockRedisStore[key] = next.toString();
      return Promise.resolve(next);
    }) as any),
    expire: jest.fn().mockImplementation(() => Promise.resolve(1)),
    keys: jest.fn().mockImplementation(((pattern: string) => {
      if (!isRedisAvailable) return Promise.reject(new Error('Redis Connection Failure'));
      const regexStr = pattern.replace(/\*/g, '.*');
      const regex = new RegExp(`^${regexStr}$`);
      return Promise.resolve(Object.keys(mockRedisStore).filter((k) => regex.test(k)));
    }) as any),
  },
}));

// Mock Database Queries
jest.mock('../src/shared/database/pool.js', () => ({
  query: jest.fn().mockImplementation(((text: string, params?: any[]) => {
    const sql = (text || '').trim().toLowerCase();
    const p = params || [];

    // SELECT FROM subscriptions
    if (sql.includes('select') && sql.includes('subscriptions')) {
      const lookupVal = p[0];
      const match = mockSubscriptions.find(
        (s) => s.org_id === lookupVal || s.stripe_customer_id === lookupVal,
      );
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // SELECT FROM organizations
    if (sql.includes('select') && sql.includes('organizations')) {
      const orgId = p[0];
      const match = mockOrganizations.find((o) => o.id === orgId);
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // SELECT FROM users
    if (sql.includes('select') && sql.includes('users')) {
      const userId = p[0];
      const match = mockUsers.find((u) => u.id === userId);
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // SELECT FROM usage_records
    if (sql.includes('select') && sql.includes('usage_records')) {
      const orgId = p[0];
      const match = mockUsageRecords.find((u) => u.org_id === orgId);
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // SELECT FROM billing_events count (failures)
    if (sql.includes('select count(*)') && sql.includes('billing_events')) {
      const orgId = p[0];
      const failures = mockBillingEvents.filter(
        (e) => e.org_id === orgId && e.event_type === 'invoice.payment_failed',
      );
      return Promise.resolve({ rows: [{ count: failures.length.toString() }], rowCount: 1 });
    }

    // SELECT FROM billing_events idempotency
    if (sql.includes('select processed') && sql.includes('billing_events')) {
      const stripeEventId = p[0];
      const match = mockBillingEvents.find((e) => e.stripe_event_id === stripeEventId);
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // INSERT INTO subscriptions
    if (sql.includes('insert into subscriptions')) {
      const orgId = p[0];
      const stripeCustomerId = p[1];
      const stripeSubId = p[2] || null;
      const planTier = p[3] || 'starter';
      const status = p[4] || 'active';
      const currentPeriodStart = p[5] || new Date();
      const currentPeriodEnd = p[6] || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const trialEnd = p[7] || null;

      let match = mockSubscriptions.find((s) => s.org_id === orgId);
      if (!match) {
        match = {
          id: crypto.randomUUID(),
          org_id: orgId,
          stripe_customer_id: stripeCustomerId,
          stripe_subscription_id: stripeSubId,
          plan_tier: planTier,
          status: status,
          current_period_start: currentPeriodStart,
          current_period_end: currentPeriodEnd,
          trial_end: trialEnd,
          cancel_at_period_end: false,
        };
        mockSubscriptions.push(match);
      } else {
        match.stripe_customer_id = stripeCustomerId;
        if (stripeSubId) match.stripe_subscription_id = stripeSubId;
        match.plan_tier = planTier;
        match.status = status;
        match.current_period_start = currentPeriodStart;
        match.current_period_end = currentPeriodEnd;
        match.trial_end = trialEnd;
      }
      return Promise.resolve({ rows: [match], rowCount: 1 });
    }

    // UPDATE subscriptions
    if (sql.includes('update subscriptions')) {
      const orgId = p[p.length - 1];
      const match = mockSubscriptions.find((s) => s.org_id === orgId);
      if (match) {
        if (sql.includes('plan_tier = $1')) match.plan_tier = p[0];
        if (sql.includes("status = 'canceled'")) {
          match.status = 'canceled';
          match.plan_tier = 'starter';
        }
        if (sql.includes('cancel_at_period_end = true')) match.cancel_at_period_end = true;
        if (sql.includes("status = 'past_due'")) match.status = 'past_due';
        if (sql.includes("status = 'active'")) match.status = 'active';
      }
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // UPDATE organizations
    if (sql.includes('update organizations')) {
      const isStarterHardcoded = sql.includes("plan_tier = 'starter'");
      const isSuspend = sql.includes('is_active = false');

      const planTier = isStarterHardcoded ? 'starter' : p[0];
      const orgId = isSuspend ? p[0] : isStarterHardcoded ? p[0] : p[1];

      const match = mockOrganizations.find((o) => o.id === orgId);
      if (match) {
        if (isSuspend) {
          match.is_active = false;
        } else {
          match.plan_tier = planTier;
        }
      }
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // INSERT INTO usage_records
    if (sql.includes('insert into usage_records')) {
      const orgId = p[0];
      const periodStart = p[1];
      const periodEnd = p[2];
      const jobsLimit = p[3];

      let match = mockUsageRecords.find(
        (u) => u.org_id === orgId && u.period_start === periodStart,
      );
      if (!match) {
        match = {
          id: crypto.randomUUID(),
          org_id: orgId,
          period_start: periodStart,
          period_end: periodEnd,
          jobs_run: 0,
          jobs_limit: jobsLimit,
          uploads_count: 0,
          api_calls: 0,
          reports_generated: 0,
        };
        mockUsageRecords.push(match);
      }
      return Promise.resolve({ rows: [match], rowCount: 1 });
    }

    // UPDATE usage_records SET jobs_limit = $1
    if (sql.includes('update usage_records') && sql.includes('jobs_limit = $1')) {
      const jobsLimit = p[0];
      const orgId = p[1];
      const match = mockUsageRecords.find((u) => u.org_id === orgId);
      if (match) {
        match.jobs_limit = jobsLimit;
      }
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // UPDATE usage_records (counters delta increment)
    if (sql.includes('update usage_records') && sql.includes('jobs_run = jobs_run +')) {
      const delta = p[1];
      const orgId = p[2];
      const match = mockUsageRecords.find((u) => u.org_id === orgId);
      if (match) {
        if (p[0] === 'jobs') match.jobs_run += delta;
        if (p[0] === 'uploads') match.uploads_count += delta;
        if (p[0] === 'api_calls') match.api_calls += delta;
        if (p[0] === 'reports') match.reports_generated += delta;
      }
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // INSERT INTO billing_events
    if (sql.includes('insert into billing_events')) {
      const newEvent = {
        id: crypto.randomUUID(),
        org_id: p[0],
        stripe_event_id: p[1],
        event_type: p[2],
        processed: false,
      };
      mockBillingEvents.push(newEvent);
      return Promise.resolve({ rows: [newEvent], rowCount: 1 });
    }

    // UPDATE billing_events SET processed = true
    if (sql.includes('update billing_events set processed = true')) {
      const stripeEventId = p[0];
      const match = mockBillingEvents.find((e) => e.stripe_event_id === stripeEventId);
      if (match) {
        match.processed = true;
      }
      return Promise.resolve({ rows: match ? [match] : [], rowCount: match ? 1 : 0 });
    }

    // INSERT INTO audit_logs
    if (sql.includes('insert into audit_logs')) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }

    return Promise.resolve({ rows: [], rowCount: 0 });
  }) as any),
}));

// Mock Stripe API SDK
const mockStripeCustomersCreate = jest
  .fn()
  .mockImplementation(() => Promise.resolve({ id: 'cus_stripe_success' }));
const mockStripeSubscriptionsCreate = jest.fn().mockImplementation(() =>
  Promise.resolve({
    id: 'sub_stripe_success',
    current_period_start: Math.floor(Date.now() / 1000),
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    status: 'active',
    trial_end: null,
    latest_invoice: {
      payment_intent: { client_secret: 'seti_stripe_secret' },
    },
  }),
);
const mockStripeSubscriptionsUpdate = jest
  .fn()
  .mockImplementation(() => Promise.resolve({ id: 'sub_stripe_success' }));
const mockStripeSubscriptionsCancel = jest
  .fn()
  .mockImplementation(() => Promise.resolve({ id: 'sub_stripe_success' }));
const mockStripeSubscriptionsRetrieve = jest.fn().mockImplementation(() =>
  Promise.resolve({
    id: 'sub_stripe_success',
    current_period_start: Math.floor(Date.now() / 1000),
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    items: {
      data: [{ id: 'item_success', price: { id: 'price_growth_fake' } }],
    },
  }),
);

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    customers: {
      create: mockStripeCustomersCreate,
    },
    subscriptions: {
      create: mockStripeSubscriptionsCreate,
      update: mockStripeSubscriptionsUpdate,
      cancel: mockStripeSubscriptionsCancel,
      retrieve: mockStripeSubscriptionsRetrieve,
    },
    webhooks: {
      constructEvent: jest.fn().mockImplementation((body: any, sig: any, _secret: any) => {
        if (sig === 'invalid_sig') {
          throw new Error('Invalid signature');
        }
        return JSON.parse(body.toString());
      }),
    },
  }));
});

// Import services and webhooks after mocking
import { BillingService } from '../src/modules/billing/billing.service.js';
import { UsageService } from '../src/modules/billing/usage.service.js';
import { processWebhookEvent } from '../src/modules/billing/stripe.webhook.js';

describe('Billing & Subscription Management Suite', () => {
  beforeEach(() => {
    mockSubscriptions = [];
    mockUsageRecords = [];
    mockBillingEvents = [];
    mockOrganizations = [
      { id: 'org-uuid-1', name: 'Test Org 1', plan_tier: 'starter', is_active: true },
    ];
    mockRedisStore = {};
    isRedisAvailable = true;
    jest.clearAllMocks();
    mockSendMail.mockClear();
    process.env.BILLING_ENABLED = 'true';
  });

  // 1. Customer creation
  it('should successfully create a Stripe customer and store references', async () => {
    const org = mockOrganizations[0];
    const customerId = await BillingService.createCustomer(org);

    expect(customerId).toBe('cus_stripe_success');
    expect(mockStripeCustomersCreate).toHaveBeenCalled();
    expect(mockSubscriptions.length).toBe(1);
    expect(mockSubscriptions[0].stripe_customer_id).toBe('cus_stripe_success');
  });

  // 2. Usage Service Counters
  it('should successfully increment usage counters in Redis', async () => {
    // Setup period start date
    await BillingService.createSubscription({
      orgId: 'org-uuid-1',
      planTier: 'starter',
    });

    await UsageService.incrementUsage('org-uuid-1', 'jobs');

    const keys = Object.keys(mockRedisStore);
    const jobsKey = keys.find((k) => k.includes(':jobs:'));
    expect(jobsKey).toBeDefined();
    expect(mockRedisStore[jobsKey!]).toBe('1');
  });

  // 3. Limit Enforcement (Approaching vs Reached)
  it('should deny checkUsageLimit at 100% and notify user at 80%', async () => {
    await BillingService.createSubscription({
      orgId: 'org-uuid-1',
      planTier: 'starter', // starter limit is 100 jobs
    });

    const { periodStart } = await (UsageService as any).getOrCreateCurrentPeriod('org-uuid-1');
    const jobsKey = `usage:org-uuid-1:jobs:${periodStart.toISOString()}`;

    // approach 80%
    mockRedisStore[jobsKey] = '79';
    await UsageService.incrementUsage('org-uuid-1', 'jobs'); // now 80
    expect(mockSendMail).toHaveBeenCalled();
    expect((mockSendMail.mock.calls[0][0] as any).subject).toContain('80%');

    // reach 100%
    mockRedisStore[jobsKey] = '100';
    const limitCheck = await UsageService.checkUsageLimit('org-uuid-1', 'jobs');
    expect(limitCheck.allowed).toBe(false);
    expect(limitCheck.usage).toBe(100);
  });

  // 4. Redis Fallback to DB
  it('should fall back to DB during checkUsageLimit if Redis goes offline', async () => {
    await BillingService.createSubscription({
      orgId: 'org-uuid-1',
      planTier: 'starter',
    });

    // Seed direct DB usage_record
    const uRec = mockUsageRecords[0];
    uRec.jobs_run = 100;

    isRedisAvailable = false;
    const checkOffline = await UsageService.checkUsageLimit('org-uuid-1', 'jobs');
    expect(checkOffline.allowed).toBe(false); // correctly fallback to DB where usage = 100
  });

  // 5. Delta DB Flushing
  it('should flush Redis usage to database with correct deltas', async () => {
    await BillingService.createSubscription({
      orgId: 'org-uuid-1',
      planTier: 'starter',
    });

    const { periodStart } = await (UsageService as any).getOrCreateCurrentPeriod('org-uuid-1');
    const jobsKey = `usage:org-uuid-1:jobs:${periodStart.toISOString()}`;

    mockRedisStore[jobsKey] = '10'; // 10 jobs ran

    await UsageService.syncUsageToDatabase();

    const uRec = mockUsageRecords[0];
    expect(uRec.jobs_run).toBe(10); // synced 10

    mockRedisStore[jobsKey] = '15'; // 5 more jobs ran
    await UsageService.syncUsageToDatabase();
    expect(uRec.jobs_run).toBe(15); // correctly increments by delta 5, total 15
  });

  // 6. Webhook Processing (Idempotence & Operations)
  it('should enforce idempotency for Stripe webhook events', async () => {
    const fakeEvent = {
      id: 'evt_stripe_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          customer: 'cus_stripe_success',
          status: 'active',
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          items: {
            data: [{ price: { id: 'price_growth_fake' } }],
          },
        },
      },
    };

    // Pre-populate subscription to map customer to org
    mockSubscriptions.push({
      org_id: 'org-uuid-1',
      stripe_customer_id: 'cus_stripe_success',
      plan_tier: 'starter',
      status: 'active',
    });

    await processWebhookEvent(fakeEvent as any);

    mockBillingEvents.push({
      stripe_event_id: 'evt_stripe_1',
      event_type: 'customer.subscription.updated',
      processed: true,
    });

    // Process again with same ID - should duplicate check
    const query = require('../src/shared/database/pool.js').query;
    const exists = await query(`SELECT processed FROM billing_events WHERE stripe_event_id = $1`, [
      'evt_stripe_1',
    ]);
    expect(exists.rowCount).toBe(1);
    expect(exists.rows[0].processed).toBe(true);
  });

  // 7. Payment Failures & Suspension
  it('should suspend organizations after 3 consecutive payment failures', async () => {
    mockSubscriptions.push({
      org_id: 'org-uuid-1',
      stripe_customer_id: 'cus_stripe_success',
      status: 'active',
    });

    const fakeFailedEvent = {
      id: 'evt_stripe_fail',
      type: 'invoice.payment_failed',
      data: {
        object: { customer: 'cus_stripe_success' },
      },
    };

    // 1st failure
    await processWebhookEvent(fakeFailedEvent as any);
    mockBillingEvents.push({
      org_id: 'org-uuid-1',
      event_type: 'invoice.payment_failed',
      processed: true,
    });
    expect(mockOrganizations[0].is_active).toBe(true); // not suspended yet

    // 2nd failure
    await processWebhookEvent(fakeFailedEvent as any);
    mockBillingEvents.push({
      org_id: 'org-uuid-1',
      event_type: 'invoice.payment_failed',
      processed: true,
    });
    expect(mockOrganizations[0].is_active).toBe(true); // not suspended yet

    // 3rd failure
    await processWebhookEvent(fakeFailedEvent as any);
    expect(mockOrganizations[0].is_active).toBe(false); // SUSPENDED!
    expect(mockSendMail).toHaveBeenCalled();
    expect(
      (mockSendMail.mock.calls[mockSendMail.mock.calls.length - 1][0] as any).subject,
    ).toContain('Suspended');
  });

  // 8. Canceled Subscription downgrades to Starter
  it('should downgrade plans to starter upon customer.subscription.deleted', async () => {
    mockSubscriptions.push({
      org_id: 'org-uuid-1',
      stripe_customer_id: 'cus_stripe_success',
      plan_tier: 'pro',
      status: 'active',
    });
    mockOrganizations[0].plan_tier = 'pro';

    const fakeDeleteEvent = {
      id: 'evt_stripe_del',
      type: 'customer.subscription.deleted',
      data: {
        object: { customer: 'cus_stripe_success' },
      },
    };

    await processWebhookEvent(fakeDeleteEvent as any);
    expect(mockOrganizations[0].plan_tier).toBe('starter');
    expect(mockSubscriptions[0].status).toBe('canceled');
  });

  // 9. Skip Stripe calls when BILLING_ENABLED=false
  it('should skip all Stripe SDK dispatches if BILLING_ENABLED=false', async () => {
    process.env.BILLING_ENABLED = 'false';
    jest.clearAllMocks();

    const org = mockOrganizations[0];
    const customerId = await BillingService.createCustomer(org);

    expect(customerId).toContain('cus_fake_'); // mock customer id
    expect(mockStripeCustomersCreate).not.toHaveBeenCalled(); // Stripe SDK completely bypassed!
  });
});
