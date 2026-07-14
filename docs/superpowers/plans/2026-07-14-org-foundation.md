# Org foundation (personal-as-org) + account view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Every account automatically has a **Personal organization** (created server-side on account creation, no signup/onboarding step), `/me` returns the orgs you're a member of with your role, and the account view shows them. Implements the identity part of the org design's Slice 1. Design record: `docs/superpowers/specs/2026-07-13-org-teams-accounts-design.md`. UI mock: Pencil frame "Account — Organizations (design)".

**Architecture:** New `organizations` + `memberships` tables. `upsertAccount` (called on every verify / verify-link) idempotently ensures a personal org + owner membership; `ensureAuthSchema` backfills existing accounts once at boot. `/me` → `{ account, orgs }`. Desktop `status()` carries orgs through to `useAccount`; the `AccountModal` signed-in panel renders an Organizations section.

**Scope now:** personal orgs only (Slice 1). Teams/invites (Slice 2) and Stripe/entitlements (HELM-16) are out of scope. Plan badges shown are placeholders until HELM-16.

**Branch:** `feature/org-foundation` off master.

**Deploy note:** the new tables + backfill ship via the idempotent `ensureAuthSchema` (runs at boot), same as the auth tables.

**Tech Stack:** Hono + node-postgres, Electron IPC, React, Vitest.

---

## File structure
- `apps/signups/src/authDb.ts` — `organizations`/`memberships` schema + backfill; `ensurePersonalOrg`; `getOrgsForAccount`; `upsertAccount` ensures the personal org.
- `apps/signups/src/auth.ts` — `/me` returns `{ account, orgs }`.
- `apps/desktop/src/main.ts` — `refreshAccount`/`rigel:account:status` return `orgs`.
- `apps/desktop/src/preload.ts` + `apps/web/src/lib/desktop.ts` — type `orgs` on `status()` + an `Org` type.
- `apps/web/src/shell/useAccount.ts` — expose `orgs`.
- `apps/web/src/shell/AccountModal.tsx` — Organizations section.

---

## Task 1: backend — org tables + personal org (`authDb.ts`)

**Files:** `apps/signups/src/authDb.ts`, `apps/signups/src/authDb.test.ts`.

- [ ] **Step 1 (test, append):** stub-pool assertions (mirror the existing authDb tests):
```typescript
test("ensureAuthSchema creates organizations + memberships and backfills", async () => {
  const { pool, calls } = recorder();
  await ensureAuthSchema(pool);
  const j = calls.map((c) => c.sql.toUpperCase()).join("\n");
  expect(j).toContain("CREATE TABLE IF NOT EXISTS ORGANIZATIONS");
  expect(j).toContain("CREATE TABLE IF NOT EXISTS MEMBERSHIPS");
  expect(j).toContain("INSERT INTO ORGANIZATIONS"); // backfill
});

test("getOrgsForAccount joins memberships + organizations, personal first", async () => {
  const { pool, calls, push } = recorder();
  push({ id: "o1", kind: "personal", name: "Jane", role: "owner" });
  const db = createAuthDb(pool);
  const orgs = await db.getOrgsForAccount("acc-1");
  expect(orgs).toEqual([{ id: "o1", kind: "personal", name: "Jane", role: "owner" }]);
  const sql = calls[0].sql.toUpperCase();
  expect(sql).toContain("FROM MEMBERSHIPS");
  expect(sql).toContain("JOIN ORGANIZATIONS");
  expect(sql).toContain("ACCOUNT_ID = $1");
  expect(calls[0].params).toEqual(["acc-1"]);
});

test("ensurePersonalOrg upserts org + owner membership idempotently", async () => {
  const { pool, calls } = recorder();
  const db = createAuthDb(pool);
  await db.ensurePersonalOrg("acc-1", "Jane");
  const j = calls.map((c) => c.sql.toUpperCase()).join("\n");
  expect(j).toContain("INSERT INTO ORGANIZATIONS");
  expect(j).toContain("ON CONFLICT");
  expect(j).toContain("INSERT INTO MEMBERSHIPS");
});
```
Also: the existing `upsertAccount` test (if it asserts exact query count) may need updating since `upsertAccount` now also calls `ensurePersonalOrg`.

- [ ] **Step 2:** `pnpm --filter signups test authDb` → FAIL.

- [ ] **Step 3:** In `authDb.ts`:
  - Add to `AUTH_SCHEMA` (after the existing tables):
    ```sql
    CREATE TABLE IF NOT EXISTS organizations (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind                text NOT NULL CHECK (kind IN ('personal','team')),
      name                text NOT NULL,
      personal_account_id uuid UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
      created_at          timestamptz NOT NULL DEFAULT now(),
      CHECK ((kind = 'personal') = (personal_account_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS memberships (
      org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      role       text NOT NULL CHECK (role IN ('owner','admin','member')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, account_id)
    );
    CREATE INDEX IF NOT EXISTS memberships_account_idx ON memberships (account_id);
    CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_owner_idx ON memberships (org_id) WHERE role = 'owner';
    -- Backfill: every existing account gets a personal org + owner membership (idempotent).
    INSERT INTO organizations (kind, name, personal_account_id)
      SELECT 'personal', coalesce(name, email), id FROM accounts a
      WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.personal_account_id = a.id);
    INSERT INTO memberships (org_id, account_id, role)
      SELECT o.id, o.personal_account_id, 'owner' FROM organizations o
      WHERE o.kind = 'personal' AND o.personal_account_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.account_id = o.personal_account_id);
    ```
  - Add types + interface methods:
    ```typescript
    export interface OrgMembership {
      id: string;
      kind: "personal" | "team";
      name: string;
      role: "owner" | "admin" | "member";
    }
    // in AuthDb:
    ensurePersonalOrg(accountId: string, name: string): Promise<void>;
    getOrgsForAccount(accountId: string): Promise<OrgMembership[]>;
    ```
  - Impl:
    ```typescript
    async ensurePersonalOrg(accountId, name) {
      await pool.query(
        `INSERT INTO organizations (kind, name, personal_account_id)
         VALUES ('personal', $2, $1) ON CONFLICT (personal_account_id) DO NOTHING`,
        [accountId, name],
      );
      await pool.query(
        `INSERT INTO memberships (org_id, account_id, role)
         SELECT id, personal_account_id, 'owner' FROM organizations
         WHERE personal_account_id = $1
         ON CONFLICT (org_id, account_id) DO NOTHING`,
        [accountId],
      );
    },
    async getOrgsForAccount(accountId) {
      const r = await pool.query(
        `SELECT o.id, o.kind, o.name, m.role
         FROM memberships m JOIN organizations o ON o.id = m.org_id
         WHERE m.account_id = $1
         ORDER BY (o.kind = 'personal') DESC, o.name`,
        [accountId],
      );
      return r.rows as OrgMembership[];
    },
    ```
  - In `upsertAccount`, after obtaining the account row, ensure the personal org before returning:
    ```typescript
    const account = r.rows[0] as Account;
    await this.ensurePersonalOrg(account.id, account.name ?? account.email);
    return account;
    ```
    (If `this` isn't bound in the object-literal style, call the local `ensurePersonalOrg` via the returned object or inline the two INSERTs. Match the file's existing structure — the methods are on one returned object, so reference them through a captured `const db = { ... }; return db;` or inline.)

- [ ] **Step 4:** tests green; typecheck.
- [ ] **Step 5:** Commit `feat(signups): organizations + memberships, auto personal org + backfill`.

---

## Task 2: backend — `/me` returns orgs (`auth.ts`)

**Files:** `apps/signups/src/auth.ts`, `apps/signups/src/auth.test.ts`.

- [ ] **Step 1 (test):** extend the `fakeDb` with `ensurePersonalOrg` (no-op that records a personal org) + `getOrgsForAccount` (returns `[{id:"o1",kind:"personal",name:"Jane",role:"owner"}]` for a known account). Add:
```typescript
test("me returns the account and its orgs", async () => {
  const { app, sent } = make();
  await json(app, "/auth/request", { email: "a@b.co" });
  const body = (await (await json(app, "/auth/verify", { email: "a@b.co", code: sent[0].code })).json()) as { token: string };
  const me = await (await app.request("/me", { headers: { authorization: `Bearer ${body.token}` } })).json() as { account: { email: string }; orgs: Array<{ kind: string; role: string }> };
  expect(me.account.email).toBe("a@b.co");
  expect(me.orgs[0]).toMatchObject({ kind: "personal", role: "owner" });
});
```

- [ ] **Step 2:** run → FAIL.

- [ ] **Step 3:** In `/me`, after `touchToken`, fetch orgs and include them:
```typescript
    await db.touchToken(sha(token));
    const orgs = await db.getOrgsForAccount(account.id);
    return c.json({ account: { id: account.id, email: account.email, name: account.name }, orgs });
```
(verify / verify-link responses are unchanged — the app fetches `/me` after sign-in.)

- [ ] **Step 4:** tests green; full signups suite green; typecheck.
- [ ] **Step 5:** Commit `feat(signups): /me returns the account's organizations`.

---

## Task 3: desktop — carry orgs to the renderer

**Files:** `apps/desktop/src/main.ts`, `apps/desktop/src/preload.ts`, `apps/web/src/lib/desktop.ts`, `apps/web/src/shell/useAccount.ts` (+ its test).

Context: `accountClient.me()` already returns `MePayload` which has `orgs?: OrgSummary[]` (`OrgSummary = { id, kind, name, role }` in `accountClient.ts` — confirm it matches `OrgMembership`; align the fields). `refreshAccount` in main currently drops orgs.

- [ ] **main.ts `refreshAccount`:** return orgs:
```typescript
  async function refreshAccount(): Promise<{ signedIn: boolean; account: {...} | null; orgs: OrgSummary[] }> {
    const payload = await accountClient.me();
    const signedIn = accountStore.getToken() != null;
    pushServerAuth(signedIn);
    return { signedIn, account: payload?.account ?? null, orgs: payload?.orgs ?? [] };
  }
```
(Import/alias the org type from `accountClient` or inline the shape.)
- [ ] **preload.ts `status`:** widen the return type to include `orgs`.
- [ ] **desktop.ts:** add an `Org` type `{ id: string; kind: "personal"|"team"; name: string; role: "owner"|"admin"|"member" }`; `status(): Promise<{ signedIn: boolean; account: Account | null; orgs: Org[] }>`.
- [ ] **useAccount.ts:** in `refresh`, store orgs; add `orgs: Org[]` to `UseAccountResult` (derive from the status result). Update `useAccount.test.tsx` mocks so `status` returns `orgs: []` (existing tests) and add one asserting orgs propagate.
- [ ] typecheck (all three) + `pnpm --filter web test useAccount` + `pnpm --filter desktop test`. Commit `feat(desktop): plumb organizations from /me to useAccount`.

---

## Task 4: UI — Organizations section in the account view

**Files:** `apps/web/src/shell/AccountModal.tsx`, `AccountModal.test.tsx`.

Match the Pencil frame "Account — Organizations (design)". In the signed-in panel, between the identity/divider and the footer, render an **Organizations** section from `account.orgs`:
- A mono uppercase "ORGANIZATIONS" label.
- One row per org: a rounded-square initial avatar (accent tint for the personal org; a distinct tint for teams — derive a stable color from the name), the display name (`kind === "personal" ? "Personal" : org.name`), a sublabel (`personal` → "Just you"; team → "N members" when available, else "Team"), and a role badge (`Owner`/`Admin`/`Member`, capitalized).
- Empty/loading: if `orgs` is empty, render nothing (or a single Personal row placeholder) — in practice every signed-in user has a personal org.
Keep the existing avatar/name/email + Sign out + Done. Tokens only (no raw-hex `style`); use the same classes the rest of the modal uses.

- [ ] Tests (`AccountModal.test.tsx`, RTL): signed-in with `orgs: [{id,kind:"personal",name:"Jane",role:"owner"}, {id,kind:"team",name:"Acme",role:"member"}]` (via the fake `UseAccountResult`) → shows "Personal", "Owner", "Acme", "Member".
- [ ] typecheck + `pnpm --filter web test` green. Commit `feat(web): show organizations in the account view`.

---

## Verification
- All packages typecheck; signups + desktop + web suites green.
- **Live (after deploy):** sign in → account view shows your **Personal** org (Owner). Existing accounts get one via the boot backfill; new accounts on first verify.

## Self-review notes (author)
- Personal org is created idempotently on every verify (`upsertAccount` → `ensurePersonalOrg`) AND backfilled at boot — every account has exactly one, no signup/onboarding step.
- `OrgSummary`/`OrgMembership`/`Org` describe the same `{id,kind,name,role}` shape across backend, bridge, and UI — keep them aligned.
- Teams (invites/membership beyond self) and per-org plans are deferred; the UI's team row + plan text are placeholders that light up when Slice 2 / HELM-16 land.
