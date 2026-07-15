import { test, expect, vi } from "vitest";
import { makeStripeAdapter } from "./stripeAdapter";

test("activeFeatureKeys returns the entitlements' lookup keys", async () => {
  const list = vi.fn(async () => ({ data: [{ lookup_key: "reliability" }, { lookup_key: "cloudConnect" }] }));
  const adapter = makeStripeAdapter({ entitlements: { activeEntitlements: { list } } } as never);
  const keys = await adapter.activeFeatureKeys("cus_1");
  expect(list).toHaveBeenCalledWith({ customer: "cus_1", limit: 100 });
  expect([...keys]).toEqual(["reliability", "cloudConnect"]);
});

test("ensureCustomer reuses an existing id and does not create", async () => {
  const create = vi.fn();
  const adapter = makeStripeAdapter({ customers: { create }, entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never);
  const r = await adapter.ensureCustomer({ existing: "cus_1", email: "a@b.co", orgId: "o1" });
  expect(r).toEqual({ customerId: "cus_1", created: false });
  expect(create).not.toHaveBeenCalled();
});

test("ensureCustomer creates when none, tagging org metadata", async () => {
  const create = vi.fn(async () => ({ id: "cus_new" }));
  const adapter = makeStripeAdapter({ customers: { create }, entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never);
  const r = await adapter.ensureCustomer({ existing: null, email: "a@b.co", orgId: "o1" });
  expect(create).toHaveBeenCalledWith({ email: "a@b.co", metadata: { orgId: "o1" } });
  expect(r).toEqual({ customerId: "cus_new", created: true });
});

test("createCheckoutSession passes per-seat line item + urls, returns url", async () => {
  const create = vi.fn(async () => ({ url: "https://checkout.stripe/s1" }));
  const adapter = makeStripeAdapter({ checkout: { sessions: { create } }, entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never);
  const url = await adapter.createCheckoutSession({ customerId: "cus_1", priceId: "price_1", quantity: 3, successUrl: "https://s/ok", cancelUrl: "https://s/no" });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({
    mode: "subscription", customer: "cus_1",
    line_items: [{ price: "price_1", quantity: 3 }],
    success_url: "https://s/ok", cancel_url: "https://s/no",
  }));
  expect(url).toBe("https://checkout.stripe/s1");
});

test("createPortalSession returns the portal url", async () => {
  const create = vi.fn(async () => ({ url: "https://portal/1" }));
  const adapter = makeStripeAdapter({ billingPortal: { sessions: { create } }, entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never);
  expect(await adapter.createPortalSession({ customerId: "cus_1", returnUrl: "https://s/back" })).toBe("https://portal/1");
});
