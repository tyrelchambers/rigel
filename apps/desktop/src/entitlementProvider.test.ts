import { test, expect } from "vitest";
import { applyGrace, createEntitlementProvider, detectAgentDowngrade } from "./entitlementProvider";
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

// ── Layer-1 downgrade edge-detection ──────────────────────────────────────
test("detectAgentDowngrade fires ONLY on a genuine true→false backed by a success", () => {
  expect(detectAgentDowngrade(true, false, true)).toBe(true);   // genuine downgrade
  expect(detectAgentDowngrade(null, false, true)).toBe(false);  // initial load / no prior success
  expect(detectAgentDowngrade(null, false, false)).toBe(false); // no-cache default (fetch failed)
  expect(detectAgentDowngrade(true, false, false)).toBe(false); // fetch failed → grace, never revert
  expect(detectAgentDowngrade(false, true, true)).toBe(false);  // upgrade
  expect(detectAgentDowngrade(true, true, true)).toBe(false);   // unchanged (still autonomous)
  expect(detectAgentDowngrade(false, false, true)).toBe(false); // unchanged (already free)
});

const proAuto: EntitlementPayload = { plan: "pro", audits: [], cloudConnect: true, agentAutonomy: true, fetchedAt: "2026-07-01T00:00:00.000Z" };
const freeNow: EntitlementPayload = { plan: "free", audits: [], cloudConnect: false, agentAutonomy: false, fetchedAt: "2026-07-05T00:00:00.000Z" };

function makeProvider(seq: (EntitlementPayload | null)[]) {
  let i = 0;
  const client = { entitlements: async () => seq[Math.min(i++, seq.length - 1)] ?? null };
  const saved: (EntitlementPayload | null)[] = [];
  const store = { load: () => saved.at(-1) ?? null, save: (v: EntitlementPayload) => saved.push(v) };
  const fired: number[] = [];
  const p = createEntitlementProvider({ client, store, now: () => Date.parse("2026-07-05") });
  p.onDowngrade(() => fired.push(1));
  return { p, fired };
}

test("provider signals a downgrade when a successful refresh flips autonomy true→false", async () => {
  const { p, fired } = makeProvider([proAuto, freeNow]);
  await p.refresh(); // establishes prev=true (autonomous) — must NOT fire
  expect(fired).toHaveLength(0);
  await p.refresh(); // true→false on a success — fires
  expect(fired).toHaveLength(1);
});

test("provider does NOT signal on the initial free fetch (no prior success)", async () => {
  const { p, fired } = makeProvider([freeNow]);
  await p.refresh();
  expect(fired).toHaveLength(0);
});

test("provider does NOT signal when the fetch fails after an autonomous success (grace)", async () => {
  const { p, fired } = makeProvider([proAuto, null]);
  await p.refresh(); // prev=true
  await p.refresh(); // fetch failed → grace, no revert
  expect(fired).toHaveLength(0);
});

test("provider does NOT re-signal on repeated free fetches after the first downgrade", async () => {
  const { p, fired } = makeProvider([proAuto, freeNow, freeNow]);
  await p.refresh();
  await p.refresh(); // fires once
  await p.refresh(); // false→false, no re-fire
  expect(fired).toHaveLength(1);
});
