import { describe, expect, test } from "vitest";
import { pendingVerification, verifyFix, VERIFY_DEADLINE_MS, VERIFY_SETTLE_MS, type VerifyView } from "./verify.js";
import type { Incident } from "./detector.js";

const T0 = 1_000_000;
const ready = (name: string, ownerUid: string, isReady = true) => ({
  metadata: { name, namespace: "default", ownerReferences: [{ controller: true, uid: ownerUid }] },
  status: { conditions: [{ type: "Ready", status: isReady ? "True" : "False" }] },
});
const dep = (name: string, desired: number, readyReplicas: number) => ({
  metadata: { name, namespace: "default" }, spec: { replicas: desired }, status: { readyReplicas },
});
const dbDown: Incident = { incidentKind: "databaseNotReady", namespace: "default", name: "postgres", reason: "NoPrimary", detail: "" };
const view = (over: Partial<VerifyView>): VerifyView => ({ now: T0, present: new Set(), incidents: [], pods: [], deps: [], ...over });

describe("verifyFix", () => {
  const restart = pendingVerification(
    { kind: "restart", deployment: "api", namespace: "default", label: "Restart api" },
    { atMs: T0, fingerprint: "fp", incident: "api", incidents: [], pods: [] },
  );

  test("waits for the settle period", () => {
    expect(verifyFix(restart, view({ now: T0 + 1000, deps: [dep("api", 3, 3)] }))).toEqual({ status: "pending" });
  });

  test("verifies once the deployment is healthy and the incident cleared", () => {
    expect(verifyFix(restart, view({ now: T0 + VERIFY_SETTLE_MS, deps: [dep("api", 3, 3)] }))).toEqual({ status: "verified" });
  });

  test("keeps waiting while unhealthy, then fails at the deadline", () => {
    const sick = { deps: [dep("api", 3, 1)] };
    expect(verifyFix(restart, view({ now: T0 + VERIFY_SETTLE_MS, ...sick }))).toEqual({ status: "pending" });
    expect(verifyFix(restart, view({ now: T0 + VERIFY_DEADLINE_MS, ...sick }))).toEqual({ status: "failed", why: "api has 1 of 3 copies running" });
  });

  test("fails when the incident is still present at the deadline", () => {
    const r = verifyFix(restart, view({ now: T0 + VERIFY_DEADLINE_MS, deps: [dep("api", 3, 3)], present: new Set(["fp"]) }));
    expect(r).toEqual({ status: "failed", why: "the problem is still there" });
  });

  test("fails right away when a database goes down after the fix", () => {
    const r = verifyFix(restart, view({ now: T0 + VERIFY_SETTLE_MS, deps: [dep("api", 3, 3)], incidents: [dbDown] }));
    expect(r).toEqual({ status: "failed", why: "the default/postgres database went down after it" });
  });

  test("a database already down before the fix doesn't count against it", () => {
    const p = pendingVerification(
      { kind: "restart", deployment: "api", namespace: "default", label: "x" },
      { atMs: T0, fingerprint: "fp", incident: "api", incidents: [dbDown], pods: [] },
    );
    expect(verifyFix(p, view({ now: T0 + VERIFY_SETTLE_MS, deps: [dep("api", 1, 1)], incidents: [dbDown] }))).toEqual({ status: "verified" });
  });

  test("deletePod is verified by a ready replacement from the same controller", () => {
    const pods = [ready("api-a", "rs1"), ready("api-b", "rs1", false)];
    const p = pendingVerification(
      { kind: "deletePod", pod: "api-b", namespace: "default", label: "x" },
      { atMs: T0, fingerprint: "fp", incident: "api", incidents: [], pods },
    );
    expect(p.readyBefore).toBe(1);
    expect(verifyFix(p, view({ now: T0 + VERIFY_SETTLE_MS, pods: [ready("api-a", "rs1"), ready("api-c", "rs1")] }))).toEqual({ status: "verified" });
    expect(verifyFix(p, view({ now: T0 + VERIFY_DEADLINE_MS, pods: [] }))).toEqual({ status: "failed", why: "the replacement for api-b isn't up" });
  });

  test("repairDatabase is verified once the database is back", () => {
    const p = pendingVerification(
      { kind: "repairDatabase", cluster: "postgres", namespace: "default", label: "x" },
      { atMs: T0, fingerprint: "db", incident: "postgres", incidents: [dbDown], pods: [] },
    );
    expect(verifyFix(p, view({ now: T0 + VERIFY_SETTLE_MS, incidents: [dbDown], present: new Set(["db"]) }))).toEqual({ status: "pending" });
    expect(verifyFix(p, view({ now: T0 + VERIFY_SETTLE_MS }))).toEqual({ status: "verified" });
  });
});
