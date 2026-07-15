import Stripe from "stripe";

export interface StripeAdapter {
  activeFeatureKeys(customerId: string): Promise<Set<string>>;
  ensureCustomer(input: { existing: string | null; email: string; orgId: string }): Promise<{ customerId: string; created: boolean }>;
  createCheckoutSession(input: { customerId: string; priceId: string; quantity: number; successUrl: string; cancelUrl: string }): Promise<string>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<string>;
}

// Injectable core for tests (takes a stripe-shaped client).
export function makeStripeAdapter(stripe: Pick<Stripe, "entitlements" | "customers" | "checkout" | "billingPortal">): StripeAdapter {
  return {
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
