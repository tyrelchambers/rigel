# Rigel desktop first-run signup capture (integrated into onboarding) — design

## Context

Rigel is distributed as a cross-platform **desktop app** (Electron) plus a self-hostable web app. The maintainer wants visibility into **who is using the desktop app** — a simple list of names + emails, the way Lens and pencil.dev capture identity on first launch. There is currently **no telemetry or signup of any kind** in the codebase. The goal is awareness/analytics ("see and get an idea of all the people using my app"), not authentication or gating beyond a one-time first-run prompt.

## Decisions (from brainstorming)

- **Lightweight capture**: name + email, self-reported, **unverified**. No OAuth, no magic link, no accounts.
- **Required on first run, but network-resilient**: the user must fill the form once; they are **never locked out** if offline or the collection server is down (save locally, retry in the background).
- **Desktop only**: prompt appears only when the SPA runs inside Electron. The self-host web app is never prompted.
- **Integrated into onboarding**: name + email is the required, non-skippable **first step** of a now-multi-step onboarding wizard (with a visible stepper); the existing optional setup (AI token, Assistant, metrics, Signal) follows as subsequent skippable steps.
- **Self-hosted data**: a new **`rigel`** database (table `signups`) in the **existing CNPG cluster**, written via a new small service reached at **`api.rigel.run`**.

## Architecture — three units

1. **Desktop client** — Electron main (identity + delivery) + preload bridge + a renderer first-run modal.
2. **Signups API** — `apps/signups`, a small Node/Hono service exposing `POST /signups`.
3. **Data + infra** — a `rigel` DB in the existing CNPG cluster, k8s manifests, `api.rigel.run` DNS + TLS.

---

### Unit 1 — Desktop client

**Electron main (`apps/desktop`):**
- On startup, ensure a persistent identity file at `app.getPath("userData")/rigel-install.json`:
  - `installId` — a UUID v4 generated once on first run.
  - `captured` — boolean; true once the user has submitted the form (controls re-prompting).
  - `pending` — the last unconfirmed payload (present until the server acks delivery).
- Expose via the preload `contextBridge`:
  - `rigel.needsSignup: boolean` — `!captured`.
  - `rigel.submitSignup({ name, email }): Promise<{ ok: true }>`.
- `submitSignup`:
  1. Build payload `{ installId, name, email, appVersion: app.getVersion(), platform: process.platform }`.
  2. Set `captured = true` and persist immediately (the **gate is "filled the form once"**, not "reached the server"). Resolve `{ ok: true }` so the UI proceeds.
  3. Write payload to `pending` and attempt the POST. On a 2xx ack, clear `pending`. On failure, leave `pending` for retry.
- **Background retry**: on every app launch, if `pending` exists, attempt the POST; clear it on success. (Bounded, simple — no exponential backoff needed for a once-per-install delivery.)
- Config (compiled in, overridable by env for dev): endpoint base `https://api.rigel.run`, a static app-key header value.

**Preload:** add only `needsSignup` + `submitSignup` to the existing minimal bridge. Keep `contextIsolation: true`, `nodeIntegration: false`.

**Renderer (`apps/web` SPA) — fold the signup into the existing onboarding as a multi-step wizard:**

Today `OnboardingWizard` (`apps/web/src/shell/OnboardingWizard.tsx`) is a single **dismissible** card of *optional* setup (AI token, Assistant, metrics-server, Signal), auto-shown after login when the AI token isn't configured (`App.tsx`, gated by `localStorage "rigel_onboarded"`). Refactor it into a **multi-step wizard with a visible step indicator** (e.g. "Step 2 of 5" + progress dots, shown on every step):

- **Step 1 — "About you" (desktop only, REQUIRED): name + email.** Included only when `window.rigel?.needsSignup` is true. On this step the wizard is **non-dismissible** and **cannot be skipped** — "Continue" stays disabled until both fields are valid (client-side validated). On Continue → `window.rigel.submitSignup({ name, email })` (recorded locally immediately; POSTed with background retry) → advance to step 2. Copy: a one-line rationale ("so we know who's using Rigel").
- **Steps 2…N — the existing optional setup**, one item per step (AI token, Assistant agent, metrics-server, Signal notifications), each **skippable** (Skip / Next), ending in **Done**. Behavior of each card is unchanged from today.
- **Web self-host, or a desktop user already captured**: `window.rigel?.needsSignup` is false/undefined → the "About you" step is omitted and the wizard is the normal **dismissible** optional flow (exactly as today).

**Trigger (`App.tsx`)**: auto-open the wizard when `window.rigel?.needsSignup` (desktop first run) **OR** the current condition (AI token not configured and not yet onboarded). When it opens because of `needsSignup`, the modal is **locked** (no backdrop-dismiss, no close) until Step 1 is submitted; afterward it behaves as the normal dismissible wizard. The existing `localStorage "rigel_onboarded"` flag still governs the optional-steps auto-show; the required Step 1 is governed by `needsSignup` (owned by Electron main), independent of it.

### Unit 2 — Signups API (`apps/signups`)

A small Node service (Hono + `@hono/node-server`, consistent with the de-Bunned server stack; `pg` for postgres).

- `POST /signups`:
  1. Reject if the static app-key header is missing/wrong → `401`.
  2. Per-IP rate-limit → `429` when exceeded.
  3. Validate body: `installId` (uuid), `name` (1–200 chars), `email` (basic shape, 1–320), `appVersion`, `platform` → `400` on failure.
  4. **Upsert** into `signups` `ON CONFLICT (install_id)` → update `name, email, app_version, platform, last_seen = now()`.
  5. Return `200 { ok: true }`.
- `GET /health` → `200` (k8s liveness/readiness).
- Postgres via `DATABASE_URL` from a k8s Secret. The `signups` table is created by a tiny idempotent migration on startup (`CREATE TABLE IF NOT EXISTS …`).
- Dockerfile on `node:26-slim`; image to GHCR; CI build + the standard deploy job (rollout restart, per the repo's deploy convention).

### Unit 3 — Data + infra

- **CNPG**: add a `rigel` database + a dedicated role (least-privilege: `INSERT/UPDATE/SELECT` on `signups`) to the existing CNPG cluster (identify cluster name/namespace during planning — likely `default`). Surface credentials as a k8s Secret consumed by the service.
- **k8s** (`apps/signups/k8s/` mirroring `apps/marketing/k8s/`): Deployment, Service, Ingress (host `api.rigel.run`, traefik, cert-manager `letsencrypt-prod` → `rigel-signups-tls`).
- **DNS**: an A record `api.rigel.run → 159.203.36.138` — **manual, maintainer-managed** (called out as a deploy step).

---

## Data flow

First launch → main ensures `installId` → the onboarding wizard opens **locked** on the required **About you** step → user enters name + email and clicks Continue → `submitSignup` sets `captured` (no future required prompt) + POSTs to `api.rigel.run/signups` with the app-key header → service validates + upserts into `rigel.signups` → `200` clears `pending`. The user then proceeds through the optional onboarding steps (which they may skip/finish). If the POST fails, `captured` is still set and `pending` is retried on subsequent launches until acked.

## Schema

```sql
CREATE TABLE IF NOT EXISTS signups (
  install_id  uuid PRIMARY KEY,
  email       text NOT NULL,
  name        text NOT NULL,
  app_version text,
  platform    text,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now()
);
```
`last_seen` bumps on every later POST, giving a free "still active" signal. Query the table directly to see who's using Rigel.

## Error handling / resilience

- **Offline / server down**: user is not blocked; data persists locally and is retried.
- **Duplicate deliveries**: idempotent upsert by `install_id`.
- **Invalid input**: client-side validation + server `400`.
- **Reinstall / new machine**: a fresh `installId` → a new row (counts as a new install — acceptable). The same person on two machines = two rows (acceptable for the awareness goal).

## Security / privacy

- The endpoint is effectively public; the static app-key header + per-IP rate-limit deter casual abuse. This is **not** real authentication and isn't meant to be (it's a signup).
- Only name, email, app version, platform, and timestamps are stored — minimal PII. The first-run screen is transparent about why. **No cluster data ever leaves the machine.**

## Testing

- **Signups service**: unit tests for body validation and the upsert (against a throwaway/test postgres or a mocked client); route tests for `200/400/401/429`; health check.
- **Client**: main-process `installId`/`captured`/`pending`/retry logic unit-tested with a temp `userData` and a mocked fetch; renderer modal renders only when `needsSignup`, validates, and calls the bridge on submit.
- **Manual (packaged desktop app)**: first launch shows the modal; submitting lands a row in postgres; submitting while offline still lets the user in and the row appears after reconnect; second launch shows no prompt.

## Out of scope (YAGNI)

- Email verification, OAuth, accounts, login/sessions.
- Self-host web capture (desktop only for now).
- Analytics dashboards or charts (query the table directly).
- Usage/event tracking beyond `first_seen` / `last_seen`.

## To resolve during planning

- The existing CNPG cluster's name/namespace and the mechanism to create the `rigel` DB + role (CNPG `managed.roles` + a bootstrap, vs a one-shot psql `Job`).
- App-key value management (a k8s Secret + a build-time constant for the client).
