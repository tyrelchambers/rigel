import Stripe from "stripe";

export type StripeMode = "test" | "live" | "none" | "unknown";

/** The Stripe mode a secret/restricted key operates in, from its prefix.
 *  sk_live_/rk_live_ → live; sk_test_/rk_test_ → test; "" → none; else unknown. */
export function stripeKeyMode(key: string): StripeMode {
  if (!key) return "none";
  if (/_live_/.test(key)) return "live";
  if (/_test_/.test(key)) return "test";
  return "unknown";
}

export interface StripeAdapter {
  activeFeatureKeys(customerId: string): Promise<Set<string>>;
  ensureCustomer(input: { existing: string | null; email: string; orgId: string }): Promise<{ customerId: string; created: boolean }>;
  createCheckoutSession(input: { customerId: string; priceId: string; quantity: number; successUrl: string; cancelUrl: string }): Promise<string>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<string>;
  /** True if the price is a live-mode object — used to guard against a key/price mode mismatch. */
  priceLivemode(priceId: string): Promise<boolean>;
}

// Injectable core for tests (takes a stripe-shaped client).
export function makeStripeAdapter(stripe: Pick<Stripe, "entitlements" | "customers" | "checkout" | "billingPortal" | "prices">): StripeAdapter {
  return {
    async priceLivemode(priceId) {
      const p = await stripe.prices.retrieve(priceId);
      return p.livemode;
    },
    async activeFeatureKeys(customerId) {
      const res = await stripe.entitlements.activeEntitlements.list({ customer: customerId, limit: 100 });
      return new Set(res.data.map((e) => e.lookup_key).filter((k): k is string => !!k));
    },
    async ensureCustomer({ existing, email, orgId }) {
      if (existing) return { customerId: existing, created: false };
      const c = await stripe.customers.create({ email, metadata: { orgId } });
      return { customerId: c.id, created: true };
    },
    async createCheckoutSession({ customerId, priceId, quantity, successUrl, cancelUrl }) {
      const s = await stripe.checkout.sessions.create({
        mode: "subscription", customer: customerId,
        line_items: [{ price: priceId, quantity }],
        success_url: successUrl, cancel_url: cancelUrl,
      });
      if (!s.url) throw new Error("stripe returned no checkout url");
      return s.url;
    },
    async createPortalSession({ customerId, returnUrl }) {
      const s = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
      return s.url;
    },
  };
}

// Production factory (real SDK).
export function createStripeAdapter(secretKey: string): StripeAdapter {
  return makeStripeAdapter(new Stripe(secretKey));
}
