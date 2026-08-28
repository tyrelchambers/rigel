import { test, expect, beforeEach, afterEach } from "vitest";
import { setEntitlement, canConnect, canBeAutonomous, cloudEnabled, unlockedAuditsEnv } from "./entitlements";

beforeEach(() => {
  process.env.RIGEL_PAID_ENTITLEMENTS = "1";
});

afterEach(() => {
  delete process.env.RIGEL_PAID_ENTITLEMENTS;
});

test("free public beta (the default) unlocks everything regardless of the pushed payload", () => {
  delete process.env.RIGEL_PAID_ENTITLEMENTS;
  setEntitlement(null);
  expect(canConnect("aws").allowed).toBe(true);
  expect(canConnect("import").allowed).toBe(true);
  expect(canBeAutonomous()).toBe(true);
  expect(cloudEnabled()).toBe(true);
  expect(unlockedAuditsEnv().split(",").sort()).toEqual(["ha", "performance", "reliability", "security"]);
});

test("default (no entitlement) → import free, cloud providers gated", () => {
  setEntitlement(null);
  expect(canConnect("import").allowed).toBe(true);
  expect(canConnect("aws").allowed).toBe(false);
  expect(canConnect("aws").reason).toMatch(/pro/i);
});

test("cloudConnect entitlement → providers allowed; audits env reflects the union", () => {
  setEntitlement({ plan: "pro", audits: ["security"], cloudConnect: true, agentAutonomy: false, fetchedAt: "t" });
  expect(canConnect("aws").allowed).toBe(true);
  expect(unlockedAuditsEnv()).toBe("security");
});

test("no entitlement → no unlocked audits in the CLI env", () => {
  setEntitlement(null);
  expect(unlockedAuditsEnv()).toBe("");
});

test("autonomy is gated on the agentAutonomy feature", () => {
  setEntitlement({ plan: "pro", audits: [], cloudConnect: true, agentAutonomy: false, fetchedAt: "t" });
  expect(canBeAutonomous()).toBe(false);
  setEntitlement({ plan: "pro", audits: [], cloudConnect: false, agentAutonomy: true, fetchedAt: "t" });
  expect(canBeAutonomous()).toBe(true);
  setEntitlement(null);
  expect(canBeAutonomous()).toBe(false);
});
