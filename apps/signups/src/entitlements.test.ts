import { test, expect, vi } from "vitest";
import { resolvePayload, makeResolver } from "./entitlements";

test("resolvePayload: no features → free", () => {
  const p = resolvePayload(new Set(), "2026-07-15T00:00:00.000Z");
  expect(p).toMatchObject({ plan: "free", audits: [], cloudConnect: false, agentAutonomy: false });
});

test("resolvePayload: unions features into the shaped payload", () => {
  const p = resolvePayload(new Set(["reliability", "security", "cloudConnect"]), "2026-07-15T00:00:00.000Z");
  expect(p.plan).toBe("pro");
  expect(p.audits.sort()).toEqual(["reliability", "security"]);
  expect(p.cloudConnect).toBe(true);
  expect(p.agentAutonomy).toBe(false);
});

test("resolveEntitlements unions across billable orgs, skipping orgs with no customer", async () => {
  const billableOrgs = vi.fn(async () => [
    { orgId: "o1", stripeCustomerId: "cus_1" },
    { orgId: "o2", stripeCustomerId: null },
    { orgId: "o3", stripeCustomerId: "cus_3" },
  ]);
  const activeFeatureKeys = vi.fn(async (c: string) =>
    c === "cus_1" ? new Set(["reliability"]) : new Set(["cloudConnect"]));
  const resolve = makeResolver({ db: { billableOrgs }, stripe: { activeFeatureKeys }, now: () => "2026-07-15T00:00:00.000Z" });
  const p = await resolve("acc-1");
  expect(activeFeatureKeys).toHaveBeenCalledTimes(2); // skipped cus-less org
  expect(p.audits).toEqual(["reliability"]);
  expect(p.cloudConnect).toBe(true);
});

test("resolveEntitlements caches per account for ~60s", async () => {
  const billableOrgs = vi.fn(async () => [{ orgId: "o1", stripeCustomerId: "cus_1" }]);
  const activeFeatureKeys = vi.fn(async () => new Set(["security"]));
  let t = 1_000_000;
  const resolve = makeResolver({ db: { billableOrgs }, stripe: { activeFeatureKeys }, now: () => new Date(t).toISOString(), monoNow: () => t });
  await resolve("acc-1");
  await resolve("acc-1"); // within window
  expect(billableOrgs).toHaveBeenCalledTimes(1);
  t += 61_000;
  await resolve("acc-1"); // window expired
  expect(billableOrgs).toHaveBeenCalledTimes(2);
});
