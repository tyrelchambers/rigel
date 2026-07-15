import { test, expect, vi } from "vitest";
import { createBillingClient } from "./billingClient";

test("checkout posts orgId with the bearer token and returns the url", async () => {
  const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ url: "https://checkout/x" }) }));
  const client = createBillingClient({ store: { getToken: () => "tok" } as never, fetchFn: fetchFn as never, endpoint: "https://api.rigel.run" });
  expect(await client.checkout("o1")).toBe("https://checkout/x");
  expect(fetchFn).toHaveBeenCalledWith("https://api.rigel.run/billing/checkout", expect.objectContaining({
    method: "POST", headers: expect.objectContaining({ authorization: "Bearer tok" }),
  }));
});

test("entitlements returns the resolved payload", async () => {
  const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ plan: "pro", audits: [], cloudConnect: true, agentAutonomy: false, fetchedAt: "t" }) }));
  const client = createBillingClient({ store: { getToken: () => "tok" } as never, fetchFn: fetchFn as never, endpoint: "https://api.rigel.run" });
  expect((await client.entitlements())?.cloudConnect).toBe(true);
});
