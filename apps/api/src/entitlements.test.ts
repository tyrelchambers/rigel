import { test, expect, vi } from "vitest";
import { resolvePayload, makeResolver, resolveOrgEntitlement } from "./entitlements";

test("resolveOrgEntitlement: agentAutonomy key → entitled + pro", async () => {
  const orgStripeCustomer = vi.fn(async () => "cus_1");
  const activeFeatureKeys = vi.fn(async () => new Set(["agentAutonomy"]));
  const r = await resolveOrgEntitlement("o1", { db: { orgStripeCustomer }, stripe: { activeFeatureKeys }, now: () => "T" });
  expect(orgStripeCustomer).toHaveBeenCalledWith("o1");
  expect(r).toMatchObject({ agentEntitled: true, plan: "pro", fetchedAt: "T" });
});

test("resolveOrgEntitlement: no stripe customer → free + not entitled", async () => {
  const orgStripeCustomer = vi.fn(async () => null);
  const activeFeatureKeys = vi.fn(async () => new Set(["agentAutonomy"]));
  const r = await resolveOrgEntitlement("o1", { db: { orgStripeCustomer }, stripe: { activeFeatureKeys }, now: () => "T" });
  expect(activeFeatureKeys).not.toHaveBeenCalled();
  expect(r).toMatchObject({ agentEntitled: false, plan: "free", fetchedAt: "T" });
});

test("resolveOrgEntitlement: customer without agentAutonomy → not entitled", async () => {
  const orgStripeCustomer = vi.fn(async () => "cus_1");
  const activeFeatureKeys = vi.fn(async () => new Set(["security"]));
  const r = await resolveOrgEntitlement("o1", { db: { orgStripeCustomer }, stripe: { activeFeatureKeys }, now: () => "T" });
  expect(r.agentEntitled).toBe(false);
});

test("LOCK-IN: resolveOrgEntitlement has no cache — every call resolves live", async () => {
  const orgStripeCustomer = vi.fn(async () => "cus_1");
  const activeFeatureKeys = vi.fn(async () => new Set(["agentAutonomy"]));
  const deps = { db: { orgStripeCustomer }, stripe: { activeFeatureKeys }, now: () => "T" };
  await resolveOrgEntitlement("o1", deps);
  await resolveOrgEntitlement("o1", deps);
  expect(orgStripeCustomer).toHaveBeenCalledTimes(2);
  expect(activeFeatureKeys).toHaveBeenCalledTimes(2);
});

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

test("resolveEntitlements: {fresh:true} bypasses the cache and re-resolves", async () => {
  const billableOrgs = vi.fn(async () => [{ orgId: "o1", stripeCustomerId: "cus_1" }]);
  const activeFeatureKeys = vi.fn(async () => new Set(["security"]));
  const t = 1_000_000;
  const resolve = makeResolver({ db: { billableOrgs }, stripe: { activeFeatureKeys }, now: () => new Date(t).toISOString(), monoNow: () => t });
  await resolve("acc-1");
  await resolve("acc-1", { fresh: true }); // within window, but forced
  expect(billableOrgs).toHaveBeenCalledTimes(2);
});

test("resolveEntitlements: a fresh resolve updates the cache for subsequent calls", async () => {
  const billableOrgs = vi.fn(async () => [{ orgId: "o1", stripeCustomerId: "cus_1" }]);
  const activeFeatureKeys = vi.fn(async () => new Set(["security"]));
  const t = 1_000_000;
  const resolve = makeResolver({ db: { billableOrgs }, stripe: { activeFeatureKeys }, now: () => new Date(t).toISOString(), monoNow: () => t });
  await resolve("acc-1", { fresh: true });
  await resolve("acc-1");
  expect(billableOrgs).toHaveBeenCalledTimes(1);
});

test("freeBeta: makeResolver returns full entitlement without hitting db/stripe", async () => {
  const billableOrgs = vi.fn(async () => { throw new Error("must not query billable orgs"); });
  const activeFeatureKeys = vi.fn(async () => { throw new Error("must not query stripe"); });
  const resolve = makeResolver({ db: { billableOrgs }, stripe: { activeFeatureKeys }, now: () => "T", freeBeta: true });
  const p = await resolve("acc-1");
  expect(billableOrgs).not.toHaveBeenCalled();
  expect(activeFeatureKeys).not.toHaveBeenCalled();
  expect(p).toMatchObject({ plan: "pro", cloudConnect: true, agentAutonomy: true, beta: true, fetchedAt: "T" });
  expect(p.audits.sort()).toEqual(["performance", "reliability", "security"]);
});

test("freeBeta: resolveOrgEntitlement returns entitled + pro without hitting db/stripe", async () => {
  const orgStripeCustomer = vi.fn(async () => { throw new Error("must not query stripe customer"); });
  const activeFeatureKeys = vi.fn(async () => { throw new Error("must not query stripe"); });
  const r = await resolveOrgEntitlement("o1", { db: { orgStripeCustomer }, stripe: { activeFeatureKeys }, now: () => "T", freeBeta: true });
  expect(orgStripeCustomer).not.toHaveBeenCalled();
  expect(r).toMatchObject({ agentEntitled: true, plan: "pro", fetchedAt: "T" });
});
