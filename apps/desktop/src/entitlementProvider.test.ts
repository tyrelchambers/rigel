import { test, expect } from "vitest";
import { applyGrace, createEntitlementProvider } from "./entitlementProvider";
import type { EntitlementPayload } from "./billingClient";

const pro: EntitlementPayload = {
  plan: "pro",
  audits: ["security"],
  cloudConnect: true,
  agentAutonomy: false,
  fetchedAt: "2026-07-01T00:00:00.000Z",
};

test("no cache → free", () => {
  expect(applyGrace(null, new Date("2026-07-02").getTime()).plan).toBe("free");
});
test("cache within 14 days → honored", () => {
  expect(applyGrace(pro, new Date("2026-07-10").getTime()).plan).toBe("pro");
});
test("cache older than 14 days → free", () => {
  expect(applyGrace(pro, new Date("2026-07-20").getTime()).plan).toBe("free");
});

test("provider fetches on start, caches, and serves the cached value; falls back to cache on fetch failure", async () => {
  let net: EntitlementPayload | null = pro;
  const client = { entitlements: async () => net };
  const saved: (EntitlementPayload | null)[] = [];
  const store = { load: () => saved.at(-1) ?? null, save: (v: EntitlementPayload) => saved.push(v) };
  const p = createEntitlementProvider({ client, store, now: () => Date.parse("2026-07-05") });
  await p.refresh();
  expect(p.current().plan).toBe("pro");
  net = null; // simulate resolver down
  await p.refresh();
  expect(p.current().plan).toBe("pro"); // still within grace from the cached fetch
});

test("a successful fetch that returns free overwrites the cached pro (real cancellation, no grace)", async () => {
  let net: EntitlementPayload | null = pro;
  const client = { entitlements: async () => net };
  const saved: (EntitlementPayload | null)[] = [];
  const store = { load: () => saved.at(-1) ?? null, save: (v: EntitlementPayload) => saved.push(v) };
  const free: EntitlementPayload = { plan: "free", audits: [], cloudConnect: false, agentAutonomy: false, fetchedAt: "2026-07-05T00:00:00.000Z" };
  const p = createEntitlementProvider({ client, store, now: () => Date.parse("2026-07-05") });
  await p.refresh();
  expect(p.current().plan).toBe("pro");
  net = free; // owner cancelled — resolver returns free
  await p.refresh();
  expect(p.current().plan).toBe("free");
});
