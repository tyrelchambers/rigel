import { test, expect, vi } from "vitest";
import { makeStripeAdapter, stripeKeyMode } from "./stripeAdapter";

test("stripeKeyMode reads the mode from the key prefix", () => {
  expect(stripeKeyMode("sk_test_abc")).toBe("test");
  expect(stripeKeyMode("rk_test_abc")).toBe("test");
  expect(stripeKeyMode("sk_live_abc")).toBe("live");
  expect(stripeKeyMode("rk_live_abc")).toBe("live");
  expect(stripeKeyMode("")).toBe("none");
  expect(stripeKeyMode("garbage")).toBe("unknown");
});

test("priceLivemode reports the price's livemode", async () => {
  const retrieve = vi.fn(async () => ({ livemode: false }));
  const adapter = makeStripeAdapter({ prices: { retrieve } } as never);
  expect(await adapter.priceLivemode("price_1")).toBe(false);
  expect(retrieve).toHaveBeenCalledWith("price_1");
});

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

test("createCheckoutSession creates an embedded session, returns the client secret", async () => {
  const create = vi.fn(async () => ({ client_secret: "cs_test_123" }));
  const adapter = makeStripeAdapter({ checkout: { sessions: { create } }, entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never);
  const secret = await adapter.createCheckoutSession({ customerId: "cus_1", priceId: "price_1", quantity: 3 });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({
    ui_mode: "embedded_page", mode: "subscription", customer: "cus_1",
    line_items: [{ price: "price_1", quantity: 3 }],
    redirect_on_completion: "never",
  }));
  expect(secret).toBe("cs_test_123");
});

test("createCheckoutSession throws when Stripe returns no client secret", async () => {
  const create = vi.fn(async () => ({ client_secret: null }));
  const adapter = makeStripeAdapter({ checkout: { sessions: { create } }, entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never);
  await expect(adapter.createCheckoutSession({ customerId: "cus_1", priceId: "price_1", quantity: 1 })).rejects.toThrow(/no client secret/);
});

test("createPortalSession returns the portal url", async () => {
  const create = vi.fn(async () => ({ url: "https://portal/1" }));
  const adapter = makeStripeAdapter({ billingPortal: { sessions: { create } }, entitlements: { activeEntitlements: { list: async () => ({ data: [] }) } } } as never);
  expect(await adapter.createPortalSession({ customerId: "cus_1", returnUrl: "https://s/back" })).toBe("https://portal/1");
});
