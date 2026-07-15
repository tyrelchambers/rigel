import Stripe from "stripe";

export interface StripeAdapter {
  activeFeatureKeys(customerId: string): Promise<Set<string>>;
}

// Injectable core for tests (takes a stripe-shaped client).
export function makeStripeAdapter(stripe: Pick<Stripe, "entitlements">): StripeAdapter {
  return {
    async activeFeatureKeys(customerId) {
      const res = await stripe.entitlements.activeEntitlements.list({ customer: customerId, limit: 100 });
      return new Set(res.data.map((e) => e.lookup_key).filter((k): k is string => !!k));
    },
  };
}

// Production factory (real SDK).
export function createStripeAdapter(secretKey: string): StripeAdapter {
  return makeStripeAdapter(new Stripe(secretKey));
}
