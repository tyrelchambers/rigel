import { test, expect, vi } from "vitest";
import { makeStripeAdapter } from "./stripeAdapter";

test("activeFeatureKeys returns the entitlements' lookup keys", async () => {
  const list = vi.fn(async () => ({ data: [{ lookup_key: "reliability" }, { lookup_key: "cloudConnect" }] }));
  const adapter = makeStripeAdapter({ entitlements: { activeEntitlements: { list } } } as never);
  const keys = await adapter.activeFeatureKeys("cus_1");
  expect(list).toHaveBeenCalledWith({ customer: "cus_1", limit: 100 });
  expect([...keys]).toEqual(["reliability", "cloudConnect"]);
});
