# Accounts + Auth — Design (HELM-15)

**Ticket:** HELM-15 (Stream 2 — user account in the UI: identity, account panel, accounts backend)
**Date:** 2026-07-13
**Status:** Design. Approved decisions below. Unblocks HELM-16 (monetization), whose resolver needs an account credential to key on.

## Problem

Rigel has no user identity. The only per-machine value is `installId` (a random
UUID in `rigel-install.json`, used purely as a waitlist correlation key, never an
auth credential). The app server (`apps/server`) is fully open. The accounts
backend (`apps/signups`) is waitlist-only. The desktop `AccountModal` is cosmetic
(`plan = "Free"` hardcoded, no session).

HELM-16 monetization cannot proceed: its backend resolver needs an authenticated
account credential to map a user to a Stripe customer. This epic builds that
identity layer.

## Goal

A real user account with a bearer credential the desktop app holds and presents to
`api.rigel.run`, plus auth on the local app server, plus a real account panel.
When this lands, HELM-16's resolver has an identity to key on and the three
entitlement swap points can read real values.

## Decisions (approved)

- **Auth model: passwordless email OTP.** Enter email → backend emails a 6-digit
  code → app exchanges the code for a long-lived bearer token. No passwords to
  store or reset. Aligns with the existing first-run email capture.
- **Transactional email: Resend.** One API key in the accounts service Secret.
- **Local server auth is separate from account identity.** A per-launch random
  session secret gates the local server. The account bearer token is a distinct
  credential, held by Electron main and sent only onward to `api.rigel.run`. The
  two concerns evolve independently and the renderer never holds the long-lived
  account token.
- **Honest threat model for the session secret.** It defends the localhost server
  against a browser tab / DNS-rebinding reaching the port. It does NOT defend
  against a hostile same-user process (any such process can read another's
  environ, memory, or scrape the SPA). There is no local defense against a
  same-user attacker, so we do not claim one. The renderer holds the session
  secret in-page, so an XSS-in-cluster-data bug would leak it; accepted for v1.
- **Secrets to the forked server travel over IPC, never env.** Both the session
  secret and the account token are delivered to `apps/server` via
  `utilityProcess.postMessage` after fork, not fork env. Fork env is world-readable
  to same-user processes (`/proc/<pid>/environ`, `ps -wwE`), which would expose the
  durable account token at runtime and defeat `safeStorage`. `forkServer`
  (`apps/desktop/src/main.ts:198`) already uses `utilityProcess.fork`, which
  supports messaging.
- **Token model: opaque, revocable, hashed at rest.** A random bearer token,
  stored as a SHA-256 hash server-side, revocable via `revoked_at`. Not a JWT:
  simpler for a single backend and revocable without a denylist. Carries a long
  max-age (e.g. 1 year) as a backstop so a leaked token is not valid forever.
- **Email is canonicalized everywhere: `lower(trim(email))`.** Applied at request,
  verify, and the unique index (a `lower(email)` unique index or `citext`).
  Without this, `Foo@X.com` and `foo@x.com` split into two accounts and the verify
  lookup misses across case, which HELM-16 would turn into duplicate/missing Stripe
  entitlements. The current validator (`apps/signups/src/validate.ts`) only trims.
- **Token-at-rest on desktop: Electron `safeStorage`** (OS keychain-encrypted),
  not a plaintext `0600` file.
- **Backend: extend `apps/signups`**, reusing its Hono + `node-postgres` service,
  `rigel` DB, and deploy. The `signups` waitlist table is untouched.

## Architecture (three units, clear boundaries)

```
Renderer (web UI)          Electron main                 apps/server (forked)        api.rigel.run (accounts)
─────────────────          ─────────────                 ────────────────────        ───────────────────────
login form + account   →   owns account identity     →   local cluster server    →   auth + accounts routes
panel (no raw token)   ↔   token in OS keychain           gated by session secret     Postgres (rigel DB)
                           (safeStorage)                   holds token for onward
                           runs OTP login flow             api.rigel.run calls
```

Each unit has one purpose, a defined interface, and is testable alone:

- **Accounts backend** — issues and validates identity. Source of truth for who a
  user is. Interface: four HTTP routes. Depends on Postgres + Resend.
- **Electron main (account identity)** — owns the credential. Runs the OTP login,
  stores the token via `safeStorage`, exposes an `account` API to the renderer
  over contextBridge, injects the token into the forked server for onward calls.
  Interface: the contextBridge `account` API + an IPC token-update to the server.
- **Local access control** — a per-launch session secret minted in main, required
  by `apps/server` on every request. Interface: one header + one WS handshake
  frame. Depends on nothing external.

## Component 1 — Accounts backend (`apps/signups`)

Reuse the existing service (`createApp({ appKey, upsert, allow, notify })`). Keep
`/health`, `/signups`, and the `signups` table exactly as they are. Add an auth
surface alongside.

### Tables (additive migration)

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,           -- stored lower(trim(email))
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_lower_idx ON accounts (lower(email));

CREATE TABLE IF NOT EXISTS login_codes (
  email       text NOT NULL,        -- lower(trim(email))
  code_hash   text NOT NULL,        -- sha256(code), never the raw code
  expires_at  timestamptz NOT NULL, -- now() + 10 min, DB time only
  attempts    int NOT NULL DEFAULT 0,
  consumed_at timestamptz,          -- single-use
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_codes_email_idx ON login_codes (email);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash   text PRIMARY KEY,    -- sha256(token)
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS auth_tokens_account_idx ON auth_tokens (account_id);
```

Schema is applied by extending `ensureSchema` (the current `SCHEMA` string
pattern) so it runs idempotently on boot, same as `signups`. `gen_random_uuid()`
requires PG 13+ (or the `pgcrypto` extension); the CNPG `rigel` DB is modern, but
the migration fails at boot if not, so verify once. All timestamp comparisons use
DB `now()` on both sides (never JS `new Date()`), so the 10-minute expiry has zero
clock skew.

### Routes

Added to `createApp` via **two** new injected deps, not seven loose functions
(matching the repo convention to keep the fetch/IO surface small): an `authDb`
object (all the account/code/token queries) and `sendCode(email, code)` (Resend).
Handlers stay pure and unit-testable against fakes, same as the current `upsert`/
`allow`/`notify` shape.

**Rate limiting.** `/auth/*` gets its own limiter instances, separate from the
`/signups` one and much tighter, with namespaced keys so budgets never collide:
- `/auth/request`: per-email ~3-5 per 10 min (anti email-bombing) AND per-IP,
  keyed `auth:req:email:<e>` / `auth:req:ip:<ip>`.
- `/auth/verify`: per-IP and per-email, keyed `auth:vrf:*`. Verify is
  unauthenticated and attacker-callable, so it must be limited too.
Constraint: the limiter is in-memory fixed-window, so counters reset on every pod
restart/deploy and are per-replica. Correct only at **one replica** — documented,
not silently assumed.

- **`POST /auth/request` `{ email }`**
  - Canonicalize `email = lower(trim(email))`; validate shape.
  - Generate a 6-digit code with `crypto.randomInt(0, 1_000_000)` zero-padded
    (never `Math.random`). Store `sha256(code)` in `login_codes`, `expires_at =
    now() + 10 min`. Invalidate prior unconsumed codes for that email. Opportunistically
    `DELETE FROM login_codes WHERE expires_at < now() - interval '1 day'` so the
    table does not grow forever.
  - Send via Resend (`sendCode`). **Await it** and distinguish outcomes: a send
    failure returns `502` (so the app can say "could not send, try again") and is
    alerted, rather than being hidden. This is not an enumeration leak: every email
    gets a code (accounts are created on first verify), so there is no
    exists/not-exists branch to conceal. Delivery failure reveals infra state, not
    account existence.
  - Success → `{ ok: true }`.

- **`POST /auth/verify` `{ email, code }`**
  - Canonicalize the email. Atomically claim an attempt against the newest
    unexpired, unconsumed code:
    `UPDATE login_codes SET attempts = attempts + 1 WHERE email=$1 AND consumed_at
    IS NULL AND expires_at > now() AND attempts < 5 AND <this is the newest row>
    RETURNING code_hash`. No row back → `401` (wrong/expired/capped). This single
    statement removes the increment/check race.
  - Constant-time compare `sha256(code)` to the returned `code_hash`. On mismatch
    → `401` (the attempt is already counted).
  - On match, atomically consume: `UPDATE login_codes SET consumed_at = now()
    WHERE ... AND consumed_at IS NULL RETURNING 1`. No row back → another request
    already consumed it → `401`. This guarantees single-use under concurrency.
  - Then upsert the `accounts` row (name from the prior signup profile if present,
    picking the latest `last_seen` row since `signups` emails are non-unique;
    update `last_login_at`), mint a random 32-byte token, store `sha256(token)` in
    `auth_tokens`, return `{ token, account: { email, name } }`.

- **`GET /me`** (Authorization: `Bearer <token>`)
  - Hash the presented token, look it up in `auth_tokens` where `revoked_at IS
    NULL` and within max-age, join `accounts`. Touch `last_used_at`. Return
    `{ account: { email, name } }`. Invalid/revoked/expired → `401`.
  - HELM-16 later extends this response with the resolved entitlement payload; no
    route change needed then, only an additive field.

- **`POST /auth/logout`** (Bearer) → set `revoked_at = now()` for that token hash.
  Idempotent. Returns `{ ok: true }`.

**`x-rigel-key` and CORS for `/auth/*`.** The auth routes do NOT require the
baked-in `x-rigel-key` (they are public, rate-limited endpoints called by the
desktop app from Node). No CORS is added for them: the existing `cors()` middleware
covers only `/signups`, and the desktop calls from Node with no `Origin`, so
`/auth/*` stays browser-blocked by default (intended — they are not a browser
surface). A minor verify timing side-channel (no-code vs expired vs wrong-code
paths differ) can reveal whether an email has a pending login; low value, accepted.

### Deploy

Add `RESEND_API_KEY` to the accounts service Secret. No new service, no new
deploy pipeline — the existing `apps/signups` image and rollout carry it.

## Component 2 — Desktop identity (Electron main)

- **`accountStore`** (new, in main): persists the token with
  `safeStorage.encryptString` into a `0600` file in userData (e.g.
  `rigel-account.bin`). `installId` and `rigel-install.json` are unchanged.
  Exposes `getToken()`, `setToken()`, `clear()`. Fail closed when real encryption
  is unavailable: require BOTH `safeStorage.isEncryptionAvailable()` AND
  `safeStorage.getSelectedStorageBackend() !== "basic_text"` (on Linux the
  `basic_text` backend is hardcoded-key obfuscation, not keychain encryption, and
  `isEncryptionAvailable()` still returns true for it). If unavailable, treat as
  signed out with a clear message rather than writing plaintext-equivalent.
  Product consequence to flag: Linux users with no keyring cannot sign in, hence
  cannot buy — HELM-16 should know this population exists.
- **`account` contextBridge API** to the renderer:
  - `requestCode(email)` → main calls `POST /auth/request`.
  - `verifyCode(email, code)` → main calls `POST /auth/verify`, stores the token
    via `accountStore`, returns only `{ email, name }`.
  - `me()` → main calls `GET /me` with the stored token; returns the profile or a
    signed-out sentinel.
  - `signOut()` → main calls `POST /auth/logout`, then `accountStore.clear()`.
  - The renderer never receives the raw token.
- **Launch refresh**: on startup, if a token exists, call `/me`. On `401`, clear
  and drop to signed-out. On network failure, keep the token and treat as
  optimistically signed-in (the credential is still valid; only the profile
  refresh failed).
- **Token and session secret to the forked server**: delivered over
  `utilityProcess.postMessage` immediately after fork (never env, per the Decisions
  note), and re-pushed on login/logout so the server can call `api.rigel.run` on
  the user's behalf. This onward-call path is what HELM-16's entitlement fetch
  consumes. In HELM-15 the server only holds the token; no server-side account
  logic ships beyond that plumbing.
- **Crash respawn**: `scheduleServerRestart` re-forks the server
  (`main.ts:280-297`). Every `forkServer` path must re-read `accountStore` and
  re-send both the session secret and the current token to the fresh child, or a
  post-login crash respawns a server with a stale/missing token. The send-secrets
  step lives inside `forkServer`, not at first boot only.

## Component 3 — Local server auth (session secret)

- Main generates a random `sessionSecret` per launch, delivers it to `apps/server`
  via `postMessage` (with the token, above) and to the renderer via
  preload/contextBridge.
- `apps/server`: a small middleware requires the secret on every `/api/*` request
  (a header, e.g. `x-rigel-session`) and as the first `/ws` frame after connect.
  Missing or wrong → `401` for HTTP, socket close for WS.
- **Exempt `/api/health`.** Main's own `waitForHealth` boot gate polls
  `GET /api/health` (`main.ts:302-319`) before it could stamp anything, so health
  must stay unauthenticated (it exposes nothing). Everything else is gated.
- **Main's own privileged calls stamp the secret.** The startup smoke test opens a
  raw `/ws` and sends `term.start` (`main.ts:450-452`); it (and any main-side
  request) must send the handshake frame / header, or phase 3 lands red. Main holds
  the secret it generated, so this is a stamp, not a new exchange.
- The renderer's existing `apiFetch` wrapper stamps the header; the WS client sends
  the handshake frame before any subscribe.
- **WS pre-auth hygiene**: an unauthenticated socket awaiting its first frame gets a
  short timeout (close if no valid handshake arrives), and the server rejects (does
  not queue) any non-handshake frame received before the handshake.
- Scope note: per the honest threat model in Decisions, this closes the browser-tab
  / DNS-rebinding hole. It is not a defense against a hostile same-user process and
  is not claimed to be. Unrelated to the account token; local access control only.

## Component 4 — Account panel UI

Upgrade the existing cosmetic `AccountModal`/`AccountGate` into a real surface,
following the app's Dialog primitives and Tailwind/token conventions.

- **Signed out**: an email field → submit calls `account.requestCode` →
  "we sent a code to <email>" → a 6-digit code field → submit calls
  `account.verifyCode` → signed in. This absorbs the first-run `AccountGate`
  (name capture folds into the account row; a returning user just enters email +
  code).
- **Signed in**: real name/email from `account.me()`, a "Sign out" button that
  calls `account.signOut()` (a neutral action, not a destructive red confirm).
  The plan/billing region stays a placeholder that HELM-16 fills; no plan logic
  ships here.
- States to handle: code sent, invalid/expired code (with a resend affordance),
  rate-limited, network error, signed-out-after-revoke.

## Build phasing (for the implementation plan)

Each phase lands and is verifiable independently:

1. **Accounts backend** — migration + four routes + Resend dep. Unit-tested
   against the Hono app with injected IO (no live DB/Resend). Verifies OTP
   lifecycle, attempt/expiry limits, no-enumeration, token mint/validate/revoke.
2. **Electron main identity** — `accountStore` (safeStorage), the `account`
   contextBridge API, launch refresh, token-to-server plumbing.
3. **Local server session-secret middleware** — HTTP + WS gate; `apiFetch` and
   the WS client stamp the secret.
4. **Account panel UI** — login flow + signed-in state, wired to `account`.

One spec covers all four; the plan sequences them. Two cross-phase constraints:
phase 3 (session secret) must ship the `/api/health` exemption and the main-side
stamping (smoke test, `waitForHealth`) in the same change, or boot goes red; and
phase 2's fork plumbing uses `postMessage`, not env (decided here, not during
implementation).

## Testing

- Backend: vitest against `createApp` with fake `authDb`/`sendCode` deps. Cover
  request → verify → me → logout, wrong code, expired code, attempt cap, reused
  code (single-use), revoked token, unknown/expired token, email-shape rejection,
  case-insensitive email match (`Foo@X.com` verifies a `foo@x.com` code),
  send-failure → `502`, request and verify rate-limit caps, and single-use holding
  under two concurrent correct verifies (only one token minted).
- Main: unit-test `accountStore` (encrypt/decrypt round trip, clear, unavailable
  keyring → fail closed) with `safeStorage` faked.
- Server: unit-test the session-secret middleware (accept correct, reject
  missing/wrong for HTTP and WS).
- Web: component tests for the panel states (signed out, code sent, error,
  signed in) with the `account` API mocked.

## Security notes

- Codes and tokens are only ever stored hashed. Raw code lives only in the email;
  raw token lives only in the desktop keychain.
- OTP: 6 digits, 10-minute expiry, single-use, 5-attempt cap, per-email + per-IP
  rate limits on BOTH `/auth/request` and `/auth/verify` (verify is unauthenticated
  and attacker-callable, so limiting it blocks the code-lockout vector). Prior
  unconsumed codes invalidated on a new request.
- No account enumeration branch exists: accounts are created on first verify, so
  every email is treated identically. `/auth/request` succeeds for any valid email
  and returns `502` only on a genuine send-infra failure (not tied to existence).
- Constant-time code comparison.
- The account token is bearer, hashed at rest, with a long max-age backstop.
  Self-logout revokes the presented token immediately via `revoked_at`. A *stolen*
  token cannot be revoked by the user in v1 (multi-session management is out of
  scope): the mitigation path is manual/admin revoke (SQL or an admin action) plus
  the max-age expiry. A "sign out everywhere" affordance is a fast follow, not v1.

## Not in scope

- Stripe, plans, entitlement resolution — that is HELM-16, which this unblocks.
- Multi-device account management UI (list/revoke other sessions).
- Password login, social OAuth, email change/merge flows.
- Hosted/remote Rigel server auth beyond the local session secret (the account
  token is designed to serve that later, but it is not built here).
