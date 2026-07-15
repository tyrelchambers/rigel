# Monetization Slice C — Flip the gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn enforcement on. A desktop **entitlement provider** (fetch on launch + every 6h, cache to disk, **14-day grace → free** fallback) becomes the source of truth; repoint the three existing allow-all seams to it (`useAuditEntitlement`, `canConnect`, the audit CLI env); add in-context "Upgrade to unlock" prompts. Done **last** — after Slice B, so a paid path exists before the wall.

**Architecture:** The provider lives in desktop main; it pushes the current (grace-applied) entitlement to the renderer (IPC) and to the forked server (`utilityProcess.postMessage`, the same channel `account-auth` uses). The server keeps a module-level entitlement, reads it in `canConnect`, and sets `RIGEL_UNLOCKED_AUDITS` when it spawns the audit CLI. The web hook maps the provider's payload to the existing `AuditEntitlement`. No gate/consumer logic is rewritten — only the *source* of the entitlement changes.

**Tech Stack:** Electron (`utilityProcess.postMessage`), TypeScript, React 19, Vitest.

**Depends on:** Slice A (`GET /entitlements`, `EntitlementPayload`) + Slice B (`billingClient.entitlements()`, billing bridge, `rigel:billing:changed`).
**Spec:** `docs/superpowers/specs/2026-07-15-monetization-foundation-design.md`.

---

## File Structure

- **Create** `apps/desktop/src/entitlementProvider.ts` — pure `applyGrace(cached, now)` + the `createEntitlementProvider({ client, store, now })` (fetch/cache/grace/free, subscribe).
- **Modify** `apps/desktop/src/main.ts` — start the provider; on change push to renderer + server; refetch on `rigel:billing:changed`; make `rigel:billing:entitlements` return the provider's current value.
- **Modify** `apps/server/src/entitlements.ts` — module-level `currentEntitlement` + `setEntitlement(payload)`; rewrite `canConnect` to read it; export `unlockedAuditsEnv()`.
- **Modify** `apps/server/src/index.ts` — `process.parentPort` handler for `{ type: "entitlement" }`; pass `RIGEL_UNLOCKED_AUDITS` from `unlockedAuditsEnv()` wherever the audit CLI is spawned.
- **Modify** `apps/web/src/panels/assistant/audits/useAuditEntitlement.ts` — read the provider payload → `AuditEntitlement`.
- **Create** `apps/web/src/shell/useEntitlement.ts` — small hook exposing the provider payload + `upgrade()` to any gated surface.
- **Modify** `apps/web/src/panels/assistant/tabs/AuditSkillsTab.tsx` + the cloud-connect 402 handler — "Upgrade to unlock" prompts.

---

## Task 1: Entitlement provider (cache + 14-day grace → free)

**Files:** Create `apps/desktop/src/entitlementProvider.ts`; Test `apps/desktop/src/entitlementProvider.test.ts`.

`FREE` = `{ plan:"free", audits:[], cloudConnect:false, agentAutonomy:false, fetchedAt:<now> }`. Grace: a cached payload is honored for 14 days from its `fetchedAt`; past that with no fresh fetch → `FREE`. No cache → `FREE`.

- [ ] **Step 1: Failing tests** (pure `applyGrace`):
```ts
import { test, expect } from "vitest";
import { applyGrace, FREE_AUDITS } from "./entitlementProvider";

const pro = { plan: "pro", audits: ["security"], cloudConnect: true, agentAutonomy: false, fetchedAt: "2026-07-01T00:00:00.000Z" };

test("no cache → free", () => {
  expect(applyGrace(null, new Date("2026-07-02").getTime()).plan).toBe("free");
});
test("cache within 14 days → honored", () => {
  expect(applyGrace(pro, new Date("2026-07-10").getTime()).plan).toBe("pro");
});
test("cache older than 14 days → free", () => {
  expect(applyGrace(pro, new Date("2026-07-20").getTime()).plan).toBe("free");
});
```
- [ ] **Step 2: Run → FAIL. Implement:**
```ts
import type { EntitlementPayload } from "./billingClient";

const GRACE_MS = 14 * 24 * 60 * 60 * 1000;
export const FREE_AUDITS: EntitlementPayload["audits"] = [];
export function free(nowMs: number): EntitlementPayload {
  return { plan: "free", audits: FREE_AUDITS, cloudConnect: false, agentAutonomy: false, fetchedAt: new Date(nowMs).toISOString() };
}
export function applyGrace(cached: EntitlementPayload | null, nowMs: number): EntitlementPayload {
  if (!cached) return free(nowMs);
  const age = nowMs - Date.parse(cached.fetchedAt);
  return age <= GRACE_MS ? cached : free(nowMs);
}
```
- [ ] **Step 3: Failing test** for the provider loop (fake client + in-memory store + injected clock):
```ts
test("provider fetches on start, caches, and serves the cached value; falls back to cache on fetch failure", async () => {
  let net = pro; const client = { entitlements: async () => net };
  const saved: (EntitlementPayload|null)[] = []; const store = { load: () => saved.at(-1) ?? null, save: (v) => saved.push(v) };
  const p = createEntitlementProvider({ client, store, now: () => Date.parse("2026-07-05") });
  await p.refresh();
  expect(p.current().plan).toBe("pro");
  net = null as never; // simulate resolver down
  await p.refresh();
  expect(p.current().plan).toBe("pro"); // still within grace from the cached fetch
});
```
- [ ] **Step 4: Run → FAIL. Implement the provider:**
```ts
export interface EntitlementProviderDeps {
  client: { entitlements(): Promise<EntitlementPayload | null> };
  store: { load(): EntitlementPayload | null; save(v: EntitlementPayload): void };
  now: () => number;
}
export function createEntitlementProvider(deps: EntitlementProviderDeps) {
  let cached: EntitlementPayload | null = deps.store.load();
  const listeners = new Set<(e: EntitlementPayload) => void>();
  const emit = () => { const e = applyGrace(cached, deps.now()); for (const l of listeners) l(e); };
  return {
    current: () => applyGrace(cached, deps.now()),
    async refresh() {
      const fresh = await deps.client.entitlements().catch(() => null);
      if (fresh) { cached = fresh; deps.store.save(fresh); }
      emit();
    },
    onChange(cb: (e: EntitlementPayload) => void) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
export type EntitlementProvider = ReturnType<typeof createEntitlementProvider>;
```
- [ ] **Step 5: Run → PASS. Commit.** `git commit -am "feat(desktop): entitlement provider (cache + 14-day grace → free)"`

---

## Task 2: Start the provider in main; push to renderer + server

**Files:** Modify `apps/desktop/src/main.ts`.

The disk store: reuse `app.getPath("userData")` + a JSON file (mirror how `AccountStore` persists, but this is non-secret so a plain file is fine). Push to server via the existing forked-server message channel (the same `pushServerAuth` uses — a `utilityProcess.postMessage`).

- [ ] **Step 1:** After `billingClient` is created (Slice B, `main.ts:437` area):
```ts
const entStore = {
  load: () => { try { return JSON.parse(readFileSync(join(app.getPath("userData"), "entitlement.json"), "utf8")); } catch { return null; } },
  save: (v: EntitlementPayload) => { try { writeFileSync(join(app.getPath("userData"), "entitlement.json"), JSON.stringify(v)); } catch {} },
};
const entitlements = createEntitlementProvider({ client: billingClient, store: entStore, now: () => Date.now() });
function pushEntitlement() {
  const e = entitlements.current();
  mainWindow?.webContents.send("rigel:billing:changed");           // renderer refetches via IPC
  pushServerMessage({ type: "entitlement", value: e });             // server gate (Task 3)
}
entitlements.onChange(pushEntitlement);
```
(`pushServerMessage` = the existing helper that `postMessage`s to the forked server — the one `pushServerAuth` uses; if `pushServerAuth` inlines the `postMessage`, factor a tiny `pushServerMessage(msg)` and have `pushServerAuth` call it. Re-send inside `forkServer` on (re)spawn, exactly like `pushServerAuth`.)

- [ ] **Step 2:** Kick the loop: `void entitlements.refresh();` after login/boot, `setInterval(() => void entitlements.refresh(), 6*60*60*1000)`, and refetch on billing changes — change the existing `rigel:billing:changed` producer (Slice B billing window) to instead call `void entitlements.refresh()` (which then emits + pushes). Also refresh on `rigel:account:status`/login so a fresh sign-in resolves entitlements.

- [ ] **Step 3:** **Replace** the `rigel:billing:entitlements` handler registered in Slice B Task 5 (Electron throws on a duplicate `ipcMain.handle` for the same channel — edit the existing line, do not add a second) so it returns the provider's current (grace-applied) value instead of a raw fetch:
```ts
ipcMain.handle("rigel:billing:entitlements", () => entitlements.current());
```
Also add a user-triggerable manual refresh (the spec calls for "immediately on a manual refresh"):
```ts
ipcMain.handle("rigel:billing:refresh", () => entitlements.refresh());
```
Expose it on the preload `billing` bridge (`refresh: () => ipcRenderer.invoke("rigel:billing:refresh")`) + the `RigelBridge.billing` type, and add a small "Refresh" affordance to the Account-panel Plan section (Slice B Task 7).
- [ ] **Step 4:** `pnpm --filter desktop typecheck && pnpm --filter desktop test`. Commit. `git commit -am "feat(desktop): drive entitlements from the provider; push to renderer + server"`

---

## Task 3: Server-side entitlement + repoint `canConnect` + audit env

**Files:** Modify `apps/server/src/entitlements.ts`; `apps/server/src/index.ts`; Test `apps/server/src/entitlements.test.ts`.

- [ ] **Step 1: Failing tests:**
```ts
import { test, expect } from "vitest";
import { setEntitlement, canConnect, unlockedAuditsEnv } from "./entitlements";

test("default (no entitlement) → import free, cloud providers gated", () => {
  setEntitlement(null);
  expect(canConnect("import").allowed).toBe(true);
  expect(canConnect("aws").allowed).toBe(false);
  expect(canConnect("aws").reason).toMatch(/pro/i);
});
test("cloudConnect entitlement → providers allowed", () => {
  setEntitlement({ plan: "pro", audits: ["security"], cloudConnect: true, agentAutonomy: false, fetchedAt: "t" });
  expect(canConnect("aws").allowed).toBe(true);
  expect(unlockedAuditsEnv()).toBe("security");
});
```
- [ ] **Step 2: Run → FAIL. Rewrite `entitlements.ts`:**
```ts
import type { CloudProvider } from "@rigel/cloud-connect/src/index";
export type ConnectTarget = CloudProvider | "import";
export interface Entitlement { allowed: boolean; reason?: string; }
// MUST mirror the canonical shape in apps/signups/src/entitlements.ts exactly —
// same field names + the precise audit union (not string[]). This is one of the
// four boundary copies of EntitlementPayload (signups → desktop billingClient →
// web desktop.ts → here); they are duplicated across package boundaries on
// purpose (like Account/Org), but their shapes must not drift.
export interface EntitlementPayload {
  plan: "free" | "pro";
  audits: ("reliability" | "security" | "performance")[];
  cloudConnect: boolean;
  agentAutonomy: boolean;
  fetchedAt: string;
}

let current: EntitlementPayload | null = null;
export function setEntitlement(e: EntitlementPayload | null): void { current = e; }

export function canConnect(target: ConnectTarget): Entitlement {
  if (target === "import") return { allowed: true }; // kubeconfig import is always free
  if (current?.cloudConnect) return { allowed: true };
  return { allowed: false, reason: "Connecting a cloud provider requires Rigel Pro." };
}
export function canBeAutonomous(): boolean { return !!current?.agentAutonomy; }
export function unlockedAuditsEnv(): string { return (current?.audits ?? []).join(","); }
```
Note: `canConnect` keeps its exact signature + return shape, so its two callers (`index.ts:247,275` → HTTP 402 `{ gated: true }`) are unchanged.

- [ ] **Step 3a: Receive the entitlement in the server.** In `apps/server/src/index.ts`, find the existing `process.parentPort.on("message", ...)` handler (the one handling `account-auth` — grep `account-auth` and `parentPort`). Add a branch: `if (msg.type === "entitlement") setEntitlement(msg.value);`. Default stays `null` (free) until the first push.

- [ ] **Step 3b: Feed the audit CLI from the live entitlement.** Locate where the audit CLI (`rigel-audit`) is spawned: `grep -rn "RIGEL_UNLOCKED_AUDITS\|rigel-audit\|configureAuditSkillsEnv" apps/server/src apps/desktop/src`. Per the code map the CLI reads `RIGEL_UNLOCKED_AUDITS` (`packages/audit-cli/src/index.ts:87`) and `configureAuditSkillsEnv` (`apps/desktop/src/main.ts:224-254`) assembles audit-skill env but does **not** set it. Set `RIGEL_UNLOCKED_AUDITS = unlockedAuditsEnv()` at the **server-side** spawn site (the process holding the live `current` entitlement), so an upgrade takes effect on the next audit run without a server restart. Add a test asserting the spawn env carries the current audits.

- [ ] **Step 3c: Gate the autonomous-agent trigger.** Find where the in-cluster agent's autonomous action is initiated server-side: `grep -rn "autonom\|auto.?fix\|remediat" apps/server/src`. Guard that entry point with `if (!canBeAutonomous()) return { gated: true }` (or the equivalent refusal the caller already handles). Add a test: autonomy blocked when `current` lacks `agentAutonomy`, allowed when present.

- [ ] **Step 4:** `pnpm --filter @rigel/server test entitlements` green; `pnpm --filter @rigel/server typecheck`. Commit. `git commit -am "feat(server): entitlement-driven canConnect + audit env + agent autonomy"`

---

## Task 4: Web — read the provider for audit gating

**Files:** Create `apps/web/src/shell/useEntitlement.ts`; Modify `apps/web/src/panels/assistant/audits/useAuditEntitlement.ts`; Tests.

- [ ] **Step 1:** `useEntitlement` — subscribes to the provider (initial `getState` + `onChanged`), returns `{ payload, upgrade }` (mirror `useAppUpdate`/`useAccount` bridge-subscription pattern):
```ts
import { useEffect, useState, useCallback } from "react";
import { rigel, type EntitlementPayload } from "@/lib/desktop";

export function useEntitlement(): { payload: EntitlementPayload | null; upgrade(orgId: string): void } {
  const [payload, setPayload] = useState<EntitlementPayload | null>(null);
  useEffect(() => {
    const b = rigel?.billing; if (!b) return;
    let cancelled = false;
    const load = () => b.entitlements().then((e) => { if (!cancelled) setPayload(e); }).catch(() => {});
    load();
    const off = b.onChanged(load);
    return () => { cancelled = true; off(); };
  }, []);
  const upgrade = useCallback((orgId: string) => void rigel?.billing?.checkout(orgId), []);
  return { payload, upgrade };
}
```
- [ ] **Step 2:** Repoint `useAuditEntitlement` (currently returns `DEFAULT_AUDIT_ENTITLEMENT`):
```ts
import { type AuditEntitlement, DEFAULT_AUDIT_ENTITLEMENT } from "@rigel/k8s";
import { useEntitlement } from "@/shell/useEntitlement";

export function useAuditEntitlement(): AuditEntitlement {
  const { payload } = useEntitlement();
  if (!payload) return { unlocked: [] };          // no bridge / not loaded yet → locked (real gate)
  return { unlocked: payload.audits };            // map the resolved payload
}
```
(Keep `DEFAULT_AUDIT_ENTITLEMENT` import for a web-only test fallback if needed; the live gate reads `payload.audits`.) `AuditSkillsTab.tsx:46,60` already calls `canRunAudit(skill.key, entitlement)` — unchanged.
- [ ] **Step 3:** Update the existing `useAuditEntitlement`/`AuditSkillsTab` tests to mock `useEntitlement` → assert locked when payload free, unlocked when payload has the kind. `pnpm --filter web test AuditSkills useAuditEntitlement` green. Commit.

---

## Task 5: In-context upgrade prompts (all three gates)

**Files:** Modify `apps/web/src/panels/assistant/tabs/AuditSkillsTab.tsx`; the autonomy control in the assistant panel; the cloud-connect 402 handler.

**`personalOrgId` source (all three prompts):** `useEntitlement().upgrade` takes the org id; the id comes from `useAccount()` — `const personalOrgId = useAccount().orgs.find(o => o.kind === "personal")?.id`. Both hooks are called in the component; do not try to source the org id from `useEntitlement` (it doesn't have it). Guard against `undefined` (disable the button until orgs load).

- [ ] **Step 1: Audit tab.** Where a skill is gated (`canRunAudit(...).allowed === false`, `AuditSkillsTab.tsx:60`), render an **"Upgrade to unlock"** button (instead of / beside "Run") that calls `upgrade(personalOrgId)`. Test: gated skill shows Upgrade, click calls `upgrade` with the personal org id.
- [ ] **Step 2: Autonomy control.** Locate the autonomous-agent toggle/control in the assistant panel: `grep -rn "autonom" apps/web/src/panels/assistant`. When `useEntitlement().payload?.agentAutonomy` is false, render the control disabled with an **"Upgrade to enable autonomy"** affordance → `upgrade(personalOrgId)`. Test: control disabled + Upgrade shown when `agentAutonomy` false.
- [ ] **Step 3: Cloud connect.** The connect flow already handles the server's `402 { gated: true }` (`apps/server/src/index.ts:247,275`). In the client connect handler (`grep -rn "gated" apps/web/src` to find where the 402 body is read), on a `gated` 402 show an **"Upgrade to unlock cloud clusters"** prompt → `upgrade(personalOrgId)`. Test the 402→prompt mapping.
- [ ] **Step 4:** `pnpm --filter web test` green. Commit. `git commit -am "feat(web): in-context upgrade prompts at the audit/autonomy/cloud gates"`

---

## Verification
- All packages test + typecheck green.
- Manual (packaged, live Stripe): a **Free** account sees audits locked, cloud-connect returns "Upgrade", agent autonomy off. **Upgrade → pay** (Slice B window) → provider refetches on window close → within seconds the same surfaces unlock (audits runnable, cloud connect allowed). **Cancel subscription** in the Portal → the next successful refetch returns free, so the plan drops to free within ~6h (or immediately via manual refresh). The 14-day grace does **not** apply to a real cancellation.
- Offline / resolver down: the cached entitlement is honored for 14 days (grace), then free — never a hard lockout. Grace covers *unreachable resolver only*, not cancellations.

## Self-review notes (author)
- Only the *source* of the entitlement changes; `canRunAudit`, the `canConnect` return shape + its 402 callers, and `parseUnlockedAudits` are all untouched (the spec's "no gate rewrites").
- Server gets entitlement via `postMessage` (runtime, no restart) — same channel as `account-auth`; env `RIGEL_UNLOCKED_AUDITS` is derived from the live value at CLI spawn.
- Provider applies cache → 14-day grace → free; `applyGrace` is pure + unit-tested. This is the enforcement flip, intentionally the last slice.
