# Accounts + Auth — Phase 3 (local server session-secret) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Gate the local app server so only the real Rigel window can reach it: a per-launch random session secret that `apps/server` requires on every `/api/*` request and on the `/ws` upgrade. Closes the "any browser tab / DNS-rebinding can hit localhost" hole. Not a defense against a hostile same-user process (out of scope, per the spec's honest threat model).

**Architecture:** Electron main mints the secret once per launch, delivers it to the forked server via **env** (`RIGEL_SESSION_SECRET`) and to the renderer via `webPreferences.additionalArguments`; the renderer stamps it on REST (`x-rigel-session` header) and WS (`?s=` query param). A pure `checkSessionSecret` validator does the check.

**Key safety rule — inert when unconfigured:** if `RIGEL_SESSION_SECRET` is empty (web-dev, tests, or any intermediate state before clients stamp), the gate **allows everything**. It enforces only when a non-empty secret is present. This makes every task independently safe — no broken intermediate, `/api/health` stays open regardless, and the web-only build is unaffected.

**Why env, not postMessage:** the session secret is ephemeral and only defends against browser-tab/DNS-rebinding, which cannot read process env anyway; the same-user-process threat that *can* read env is explicitly out of scope. (postMessage stays reserved for the durable account token — HELM-16.) Env mirrors the existing `PORT`/`HOST` delivery, avoiding new plumbing through the generated `server-entry.mjs` watchdog.

**Tech Stack:** TypeScript, Node `ws`, `@hono/node-server` (raw `fetch` handler), Electron (`webPreferences.additionalArguments`, `process.argv`), Vitest.

**Verified integration points (recon):**
- HTTP: single `handler(req)` at `apps/server/src/index.ts:137`; `url` at :139; `/api/health` branch at :142-144 (must stay open).
- WS: upgrade handler at :1255-1266 (pathname check at :1258 — insert secret check right after); connection at :1268.
- Window: `webPreferences` at `apps/desktop/src/main.ts:335-339`; `forkServer` env at :199-205; smoke-test WS at ~:450; `waitForHealth` polls `/api/health` (already exempt — no change).
- Client: `apiFetch` at `apps/web/src/lib/api.ts:9-15` (sole REST wrapper); WS `new WebSocket` at `apps/web/src/lib/ws.ts:271`.

Commands from repo root. Tests: `pnpm --filter @rigel/server test`, `pnpm --filter web test`. Typecheck: `pnpm --filter @rigel/server typecheck`, `pnpm --filter desktop typecheck`, `pnpm --filter web typecheck`.

---

## File structure
- Create `apps/server/src/sessionAuth.ts` — pure `checkSessionSecret(provided, expected)` (mirrors `requestContext.ts`).
- Modify `apps/server/src/index.ts` — read `RIGEL_SESSION_SECRET`; gate `/api/*` (except health) in `handler`; gate the `/ws` upgrade.
- Modify `apps/desktop/src/main.ts` — mint the secret; add to `forkServer` env + `createWindow` `additionalArguments`; stamp the smoke-test WS URL.
- Modify `apps/desktop/src/preload.ts` — expose `rigel.sessionSecret` (read from `process.argv`).
- Modify `apps/web/src/lib/desktop.ts` — type `sessionSecret: string` on `RigelBridge`.
- Modify `apps/web/src/lib/api.ts` — stamp `x-rigel-session` in `apiFetch`.
- Modify `apps/web/src/lib/ws.ts` — append `?s=<secret>` to the WS URL.

---

## Task 1: `checkSessionSecret` validator

**Files:** Create `apps/server/src/sessionAuth.ts`; Test `apps/server/src/sessionAuth.test.ts`.

- [ ] **Step 1: Write the failing test:**

```typescript
// apps/server/src/sessionAuth.test.ts
import { describe, it, expect } from "vitest";
import { checkSessionSecret } from "./sessionAuth";

describe("checkSessionSecret", () => {
  it("allows everything when no secret is configured (empty expected = disabled)", () => {
    expect(checkSessionSecret(null, "")).toBe(true);
    expect(checkSessionSecret("anything", "")).toBe(true);
    expect(checkSessionSecret(undefined, "")).toBe(true);
  });
  it("accepts an exact match", () => {
    expect(checkSessionSecret("s3cr3t", "s3cr3t")).toBe(true);
  });
  it("rejects a mismatch, missing, or wrong-length value when configured", () => {
    expect(checkSessionSecret("nope", "s3cr3t")).toBe(false);
    expect(checkSessionSecret(null, "s3cr3t")).toBe(false);
    expect(checkSessionSecret(undefined, "s3cr3t")).toBe(false);
    expect(checkSessionSecret("", "s3cr3t")).toBe(false);
    expect(checkSessionSecret("s3cr3tX", "s3cr3t")).toBe(false);
  });
});
```

- [ ] **Step 2:** `pnpm --filter @rigel/server test sessionAuth` → FAIL (module missing).

- [ ] **Step 3: Implement:**

```typescript
// apps/server/src/sessionAuth.ts
import { timingSafeEqual } from "node:crypto";

/** Local-access-control check. When `expected` is empty the gate is DISABLED
 *  (allow-all) — used in web-dev and before the desktop delivers a secret. */
export function checkSessionSecret(provided: string | null | undefined, expected: string): boolean {
  if (!expected) return true;
  if (typeof provided !== "string" || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}
```

- [ ] **Step 4:** `pnpm --filter @rigel/server test sessionAuth` → PASS. `pnpm --filter @rigel/server typecheck` → clean.
- [ ] **Step 5: Commit** `feat(server): checkSessionSecret validator (inert when unconfigured)`.

---

## Task 2: gate the server (`index.ts`)

**Files:** Modify `apps/server/src/index.ts`.

- [ ] **Step 1:** Add the import near the other local imports:
```typescript
import { checkSessionSecret } from "./sessionAuth";
```
- [ ] **Step 2:** Add the config read near `PORT`/`HOST` (top of the file):
```typescript
const SESSION_SECRET = process.env.RIGEL_SESSION_SECRET ?? "";
```
- [ ] **Step 3:** In `handler`, immediately AFTER the `/api/health` branch (`index.ts:142-144`) and before the other `/api/*` routes, insert the gate:
```typescript
    if (url.pathname.startsWith("/api/") && !checkSessionSecret(req.headers.get("x-rigel-session"), SESSION_SECRET)) {
      return new Response("unauthorized", { status: 401 });
    }
```
(Health already returned above, so it is exempt. Static/SPA serving is not under `/api/`, so it stays open — the browser must load the page before it can stamp anything.)

- [ ] **Step 4:** In the `httpServer.on("upgrade", ...)` handler, right after the `if (url.pathname !== "/ws") { socket.destroy(); return; }` block (`index.ts:1258-1261`), insert:
```typescript
    if (!checkSessionSecret(url.searchParams.get("s"), SESSION_SECRET)) {
      socket.destroy();
      return;
    }
```
(`url` is already parsed at :1257.)

- [ ] **Step 5: Verify** `pnpm --filter @rigel/server typecheck` → clean; `pnpm --filter @rigel/server test` → green (existing suite unaffected; the gate is inert with no env set). `pnpm --filter @rigel/server build` → succeeds.
- [ ] **Step 6: Commit** `feat(server): require session secret on /api/* + /ws when configured`.

---

## Task 3: mint + deliver the secret (`main.ts`)

**Files:** Modify `apps/desktop/src/main.ts`.

- [ ] **Step 1:** Add `randomBytes` import: `import { randomBytes } from "node:crypto";` (or add to an existing node:crypto import if present).
- [ ] **Step 2:** Add a module-level const near `SIGNUP_ENDPOINT`:
```typescript
const SESSION_SECRET = randomBytes(24).toString("hex");
```
- [ ] **Step 3:** In `forkServer`, add to the `env` object (near `PORT`/`HOST` at :201-205):
```typescript
  env.RIGEL_SESSION_SECRET = SESSION_SECRET;
```
(This runs on every `forkServer` call, so a crash-respawned server gets the same secret — no extra work.)
- [ ] **Step 4:** In `createWindow`, add to `webPreferences` (:335-339):
```typescript
      additionalArguments: [`--rigel-session=${SESSION_SECRET}`],
```
- [ ] **Step 5:** Find the startup smoke-test WS open (~`main.ts:450`, `new WebSocket("ws://…/ws")`) and append the secret:
```typescript
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws?s=${SESSION_SECRET}`);
```
(Match the exact existing variable for the port; read the surrounding lines. `waitForHealth` uses `/api/health` and needs NO change — it's exempt.)
- [ ] **Step 6: Verify** `pnpm --filter desktop typecheck` → clean; `pnpm --filter desktop test` → green.
- [ ] **Step 7: Commit** `feat(desktop): mint per-launch session secret; deliver to server (env) + renderer (argv)`.

---

## Task 4: expose the secret to the renderer (`preload.ts` + `desktop.ts`)

**Files:** Modify `apps/desktop/src/preload.ts`, `apps/web/src/lib/desktop.ts`.

- [ ] **Step 1:** In `preload.ts`, before the `exposeInMainWorld` call, read the arg:
```typescript
const sessionArg = process.argv.find((a) => a.startsWith("--rigel-session="));
const sessionSecret = sessionArg ? sessionArg.slice("--rigel-session=".length) : "";
```
Add `sessionSecret,` as a field in the `rigel` object literal (alongside `desktop`, `platform`, etc.).
- [ ] **Step 2:** In `apps/web/src/lib/desktop.ts`, add to the `RigelBridge` interface:
```typescript
  sessionSecret: string;
```
- [ ] **Step 3: Verify** `pnpm --filter desktop typecheck` and `pnpm --filter web typecheck` → clean.
- [ ] **Step 4: Commit** `feat(desktop): expose rigel.sessionSecret to the renderer`.

---

## Task 5: stamp the secret on client requests (`api.ts` + `ws.ts`)

**Files:** Modify `apps/web/src/lib/api.ts`, `apps/web/src/lib/ws.ts`.

- [ ] **Step 1: `api.ts`** — import `rigel` (add to the existing `@/lib/desktop` import if present, else add one) and rewrite `apiFetch` so it always builds headers and adds both the context and the session secret when available:
```typescript
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const ctx = useCluster.getState().activeContext;
  if (ctx) headers.set("X-Rigel-Context", ctx);
  const secret = rigel?.sessionSecret;
  if (secret) headers.set("x-rigel-session", secret);
  return fetch(input, { ...init, headers });
}
```
- [ ] **Step 2: `ws.ts`** — import `rigel` from `@/lib/desktop` and append the secret to the WS URL at the `new WebSocket(...)` site (:271):
```typescript
  const secret = rigel?.sessionSecret;
  socket = new WebSocket(`ws://${location.host}/ws${secret ? `?s=${encodeURIComponent(secret)}` : ""}`);
```
- [ ] **Step 3: Verify** `pnpm --filter web typecheck` → clean; `pnpm --filter web test` → green (jsdom tests have no `rigel`, so no header/param is added — behavior unchanged for tests).
- [ ] **Step 4: Commit** `feat(web): stamp x-rigel-session on REST + WS`.

---

## Phase 3 verification
- [ ] All four packages typecheck; `@rigel/server` + `web` test suites green.
- [ ] **Live smoke (when running the desktop app):** the app boots (health poll works — exempt), the SPA loads, WS connects, and `/api/*` calls succeed (window stamps the secret). A bare `curl http://127.0.0.1:<port>/api/contexts` WITHOUT the header returns 401; `/api/health` returns 200. Deferred to a `pnpm --filter desktop dev` run.

## Self-review notes (author)
- Covers spec Component 3: session-secret gate on `/api/*` (health exempt) + `/ws`, secret minted per launch, delivered to server + renderer, stamped by `apiFetch` + the WS client; main's own health poll needs no stamping (exempt) and the smoke test is updated. The "first WS frame + timeout" from the umbrella spec is simplified to a `?s=` query param validated at upgrade — same threat coverage, far less code, no per-connection buffering/timeout changes.
- Inert-when-unconfigured makes every task independently safe and keeps web-dev/tests working.
- Type consistency: `checkSessionSecret(provided, expected)` used identically in the HTTP and WS gates; `rigel.sessionSecret` typed on `RigelBridge` and read in `api.ts`/`ws.ts`.
