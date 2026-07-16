import { test, expect, vi } from "vitest";
import { createBillingClient } from "./billingClient";

test("checkout posts orgId with the bearer token and returns the clientSecret + publishableKey", async () => {
  const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ clientSecret: "cs_123", publishableKey: "pk_123" }) }));
  const client = createBillingClient({ store: { getToken: () => "tok" } as never, fetchFn: fetchFn as never, endpoint: "https://api.rigel.run" });
  expect(await client.checkout("o1")).toEqual({ clientSecret: "cs_123", publishableKey: "pk_123" });
  expect(fetchFn).toHaveBeenCalledWith("https://api.rigel.run/billing/checkout", expect.objectContaining({
    method: "POST", headers: expect.objectContaining({ authorization: "Bearer tok" }), body: JSON.stringify({ orgId: "o1" }),
  }));
});

test("checkout returns null and logs on a non-2xx response", async () => {
  const fetchFn = vi.fn(async () => ({ ok: false, status: 403, text: async () => "forbidden" }));
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const client = createBillingClient({ store: { getToken: () => "tok" } as never, fetchFn: fetchFn as never, endpoint: "https://api.rigel.run" });
  expect(await client.checkout("o1")).toBeNull();
  expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("403"));
  errorSpy.mockRestore();
});

test("checkout returns null and logs on a malformed body", async () => {
  const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ clientSecret: "cs_123" }) }));
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const client = createBillingClient({ store: { getToken: () => "tok" } as never, fetchFn: fetchFn as never, endpoint: "https://api.rigel.run" });
  expect(await client.checkout("o1")).toBeNull();
  expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("malformed body"));
  errorSpy.mockRestore();
});

test("checkout returns null and logs on a network error", async () => {
  const fetchFn = vi.fn(async () => { throw new Error("offline"); });
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const client = createBillingClient({ store: { getToken: () => "tok" } as never, fetchFn: fetchFn as never, endpoint: "https://api.rigel.run" });
  expect(await client.checkout("o1")).toBeNull();
  expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("threw"));
  errorSpy.mockRestore();
});

test("portal posts orgId with the bearer token and returns the url", async () => {
  const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ url: "https://portal/x" }) }));
  const client = createBillingClient({ store: { getToken: () => "tok" } as never, fetchFn: fetchFn as never, endpoint: "https://api.rigel.run" });
  expect(await client.portal("o1")).toBe("https://portal/x");
  expect(fetchFn).toHaveBeenCalledWith("https://api.rigel.run/billing/portal", expect.objectContaining({
    method: "POST", headers: expect.objectContaining({ authorization: "Bearer tok" }),
  }));
});

test("agentToken posts orgId with the bearer token and returns token+installId", async () => {
  const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ token: "rig_agent_x", installId: "id-1" }) }));
  const client = createBillingClient({ store: { getToken: () => "tok" } as never, fetchFn: fetchFn as never, endpoint: "https://api.rigel.run" });
  expect(await client.agentToken("o1")).toEqual({ token: "rig_agent_x", installId: "id-1" });
  expect(fetchFn).toHaveBeenCalledWith("https://api.rigel.run/agent/token", expect.objectContaining({
    method: "POST",
    headers: expect.objectContaining({ authorization: "Bearer tok" }),
    body: JSON.stringify({ orgId: "o1" }),
  }));
});

test("agentToken returns null when the mint fails (non-member / backend down)", async () => {
  const fetchFn = vi.fn(async () => ({ ok: false, json: async () => ({ error: "not a member" }) }));
  const client = createBillingClient({ store: { getToken: () => "tok" } as never, fetchFn: fetchFn as never, endpoint: "https://api.rigel.run" });
  expect(await client.agentToken("o1")).toBeNull();
});

test("entitlements returns the resolved payload", async () => {
  const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ plan: "pro", audits: [], cloudConnect: true, agentAutonomy: false, fetchedAt: "t" }) }));
  const client = createBillingClient({ store: { getToken: () => "tok" } as never, fetchFn: fetchFn as never, endpoint: "https://api.rigel.run" });
  expect((await client.entitlements())?.cloudConnect).toBe(true);
  expect(fetchFn).toHaveBeenCalledWith("https://api.rigel.run/entitlements", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer tok" }) }));
});

test("entitlements(fresh) requests ?fresh=1 to bypass the server cache", async () => {
  const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ plan: "pro", audits: [], cloudConnect: true, agentAutonomy: false, fetchedAt: "t" }) }));
  const client = createBillingClient({ store: { getToken: () => "tok" } as never, fetchFn: fetchFn as never, endpoint: "https://api.rigel.run" });
  await client.entitlements(true);
  expect(fetchFn).toHaveBeenCalledWith("https://api.rigel.run/entitlements?fresh=1", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer tok" }) }));
});
