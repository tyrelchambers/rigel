import { test, expect, beforeEach } from "vitest";
import { cloudGateResponse, isCloudContext, isCloudExempt, gated402, resetCloudContextCache } from "./cloudGate";
import { setEntitlement } from "./entitlements";
import type { ClusterContext } from "./contexts";

const ctx = (name: string, server: string): ClusterContext => ({ name, cluster: name, server, active: false });

const CONTEXTS: ClusterContext[] = [
  ctx("gke_proj_us-central1_prod", "https://34.121.0.1"),
  ctx("prod-eks", "https://ABC.gr7.us-east-1.eks.amazonaws.com"),
  ctx("kind-dev", "https://127.0.0.1:52001"),
  ctx("home", "https://10.0.0.5:6443"),
];

const load = () => Promise.resolve(CONTEXTS);
const free = () => setEntitlement(null);
const pro = () => setEntitlement({ plan: "pro", audits: [], cloudConnect: true, agentAutonomy: false, fetchedAt: "t" });

beforeEach(() => {
  resetCloudContextCache();
  free();
});

test("isCloudExempt covers the import/list/remove routes, not context-scoped ones", () => {
  expect(isCloudExempt("/api/health")).toBe(true);
  expect(isCloudExempt("/api/contexts")).toBe(true);
  expect(isCloudExempt("/api/cluster/delete")).toBe(true);
  expect(isCloudExempt("/api/cluster/disconnect")).toBe(true);
  expect(isCloudExempt("/api/cloud/import")).toBe(true);
  expect(isCloudExempt("/api/cloud/connect")).toBe(true);
  expect(isCloudExempt("/api/pods")).toBe(false);
  expect(isCloudExempt("/api/action")).toBe(false);
});

test("isCloudContext classifies via the cached kubeconfig", async () => {
  expect(await isCloudContext("gke_proj_us-central1_prod", load)).toBe(true);
  expect(await isCloudContext("prod-eks", load)).toBe(true);
  expect(await isCloudContext("kind-dev", load)).toBe(false);
  expect(await isCloudContext("home", load)).toBe(false);
  expect(await isCloudContext("does-not-exist", load)).toBe(false);
});

test("gate returns 402 { gated } for a cloud context on Free", async () => {
  const res = await cloudGateResponse("/api/action", "prod-eks", load);
  expect(res?.status).toBe(402);
  const body = await res!.json();
  expect(body).toEqual({ error: "Cloud clusters are a Pro feature", gated: true });
});

test("gate allows a cloud context when cloudConnect is unlocked", async () => {
  pro();
  expect(await cloudGateResponse("/api/action", "prod-eks", load)).toBeNull();
});

test("gate always allows a local context, even on Free", async () => {
  expect(await cloudGateResponse("/api/action", "kind-dev", load)).toBeNull();
  expect(await cloudGateResponse("/api/pods", "home", load)).toBeNull();
});

test("gate never fires for exempt routes even on a cloud context", async () => {
  for (const p of ["/api/contexts", "/api/cloud/import", "/api/cluster/delete", "/api/cluster/disconnect"]) {
    expect(await cloudGateResponse(p, "prod-eks", load)).toBeNull();
  }
});

test("gate ignores non-api paths (static UI, /ws) and a null context", async () => {
  expect(await cloudGateResponse("/index.html", "prod-eks", load)).toBeNull();
  expect(await cloudGateResponse("/ws", "prod-eks", load)).toBeNull();
  expect(await cloudGateResponse("/api/action", null, load)).toBeNull();
});

test("gated402 is a standalone 402 with the gated flag", async () => {
  const res = gated402();
  expect(res.status).toBe(402);
  expect(await res.json()).toEqual({ error: "Cloud clusters are a Pro feature", gated: true });
});

test("a context absent from the cache triggers one refresh", async () => {
  let calls = 0;
  const counting = () => { calls++; return Promise.resolve(CONTEXTS); };
  expect(await isCloudContext("prod-eks", counting)).toBe(true);
  expect(calls).toBe(1);
  expect(await isCloudContext("missing", counting)).toBe(false);
  expect(calls).toBe(2);
});
