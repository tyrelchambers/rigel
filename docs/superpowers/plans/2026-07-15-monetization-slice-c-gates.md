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

- [ ] **Step 3:** Make the entitlements IPC return the provider's current (grace-applied) value, not a raw fetch:
```ts
ipcMain.handle("rigel:billing:entitlements", () => entitlements.current());
```
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
export interface EntitlementPayload { plan: "free"|"pro"; audits: string[]; cloudConnect: boolean; agentAutonomy: boolean; fetchedAt: string; }

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

- [ ] **Step 3: Wire the message + env in `index.ts`.** Add a `process.parentPort` message handler (next to the existing `account-auth` one) that calls `setEntitlement(msg.value)`. Wherever the server spawns the audit CLI / chat `claude`, inject `RIGEL_UNLOCKED_AUDITS: unlockedAuditsEnv()` into that subprocess env (currently unset — `configureAuditSkillsEnv` in the desktop main.ts:224-254 does not set it; set it server-side from the live entitlement so upgrades take effect without a restart). Gate the autonomous-agent trigger on `canBeAutonomous()`.

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

## Task 5: In-context upgrade prompts

**Files:** Modify `apps/web/src/panels/assistant/tabs/AuditSkillsTab.tsx`; the cloud-connect flow that handles the server's 402.

- [ ] **Step 1: Audit tab.** Where a skill is gated (`canRunAudit(...).allowed === false`, `AuditSkillsTab.tsx:60`), render an **"Upgrade to unlock"** button (instead of / beside "Run") that calls `useEntitlement().upgrade(personalOrgId)`. Test: gated skill shows Upgrade, click calls `upgrade`.
- [ ] **Step 2: Cloud connect.** The connect flow already handles the server's `402 { gated: true }` (`apps/server/src/index.ts:247,275`). In the client connect handler, on a `gated` 402 show an "Upgrade to unlock cloud clusters" prompt → `upgrade(personalOrgId)` (opens the billing window). Test the 402→prompt mapping.
- [ ] **Step 3:** `pnpm --filter web test` green. Commit. `git commit -am "feat(web): in-context upgrade prompts at the audit + cloud gates"`

---

## Verification
- All packages test + typecheck green.
- Manual (packaged, live Stripe): a **Free** account sees audits locked, cloud-connect returns "Upgrade", agent autonomy off. **Upgrade → pay** (Slice B window) → provider refetches on window close → within seconds the same surfaces unlock (audits runnable, cloud connect allowed). **Cancel subscription** in the Portal → drops to free on next refetch (after the 14-day client grace, never mid-session).
- Offline: cached entitlement honored 14 days, then free — never a hard lockout.

## Self-review notes (author)
- Only the *source* of the entitlement changes; `canRunAudit`, the `canConnect` return shape + its 402 callers, and `parseUnlockedAudits` are all untouched (the spec's "no gate rewrites").
- Server gets entitlement via `postMessage` (runtime, no restart) — same channel as `account-auth`; env `RIGEL_UNLOCKED_AUDITS` is derived from the live value at CLI spawn.
- Provider applies cache → 14-day grace → free; `applyGrace` is pure + unit-tested. This is the enforcement flip, intentionally the last slice.
