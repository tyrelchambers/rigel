# Embedded Stripe Checkout in the Account modal — Design

**Ticket:** HELM-16 (monetization) follow-up
**Date:** 2026-07-16
**Status:** Draft for review.

## Goal

Replace the current **hosted Stripe Checkout in a separate BrowserWindow** with **Stripe Embedded Checkout rendered inside the Account modal**. Click "Upgrade to Pro" → the modal body swaps to an in-place Stripe-hosted checkout form → on completion the modal refetches entitlement and returns to the account view showing Pro. No second window, no redirect-URL detection.

## Why Embedded Checkout (not raw Elements)

Embedded Checkout keeps Stripe owning the payment form (PCI-light, SCA/3DS, tax, promo codes, wallets) — it is the current `createCheckoutSession` call with `ui_mode: 'embedded'` and one client component, versus building and maintaining a bespoke subscription form. (Decided with the user; raw Payment Element was the alternative.)

## Current flow (to change)

- `POST /billing/checkout` (signups) → `createCheckoutSession` returns a hosted **URL** → `{ url }`.
- Desktop `main.ts` `rigel:billing:checkout` IPC → `billingClient.checkout` → `openBillingWindow(url)` (a `BrowserWindow` that watches for the `${endpoint}/billing/complete` redirect, then closes + refetches).
- Renderer never sees Stripe; it just triggers the IPC.

## New flow

1. Renderer "Upgrade" → IPC `rigel:billing:checkout` (unchanged trigger; main still holds the account bearer).
2. `billingClient.checkout` → `POST /billing/checkout` → returns **`{ clientSecret, publishableKey }`** instead of `{ url }`.
3. Main returns `{ clientSecret, publishableKey }` to the renderer (no window opened).
4. Renderer mounts `<EmbeddedCheckoutProvider stripe={loadStripe(publishableKey)} options={{ clientSecret }}>` + `<EmbeddedCheckout />` **inside the Account modal body**.
5. Session created with `redirect_on_completion: 'never'`; the provider's **`onComplete`** fires when payment succeeds → renderer calls `refreshBilling()` and swaps back to the account view (now Pro).

## Changes by file

### signups (backend)

- **`stripeAdapter.ts` `createCheckoutSession`** — change signature/impl to embedded:
  - Input: `{ customerId, priceId, quantity, returnUrl? }` (drop `successUrl`/`cancelUrl`).
  - Params: `ui_mode: 'embedded'`, `mode: 'subscription'`, `redirect_on_completion: 'never'` (no `return_url` needed in Electron; the client uses `onComplete`).
  - Return: `session.client_secret` (string) instead of `session.url`.
  - Keep `createPortalSession` as-is (portal stays a hosted window for now — out of scope).
- **`billing.ts` `POST /billing/checkout`** — return `c.json({ clientSecret, publishableKey: deps.publishableKey })` (was `{ url }`). Same auth/membership/owner gates. The static `/billing/complete|cancelled` HTML pages are now only used by the portal; keep them.
- **`BillingDeps`** — add `publishableKey: string`.
- **`index.ts`** — read `STRIPE_PUBLISHABLE_KEY` from env; thread into `billing` deps. Add a boot guard: the publishable key's mode (`pk_live_`/`pk_test_`) must match `stripeKeyMode(STRIPE_SECRET_KEY)` — warn (or exit, matching the existing price-mode guard) on mismatch. Warn if unset (`/billing/checkout` will fail client-side without it).
- **`k8s/db-secret.example.yaml` + `docs/stripe-setup.md`** — document `STRIPE_PUBLISHABLE_KEY` (public; still keep test/live in the right Secret).

### desktop (main + preload + bridge)

- **`main.ts` `rigel:billing:checkout`** — return `await billingClient.checkout(orgId)` (now `{ clientSecret, publishableKey } | null`) directly; **do not** call `openBillingWindow`. Portal handler unchanged (still opens a window).
- **`billingClient.ts` `checkout`** — return `{ clientSecret, publishableKey } | null` (parse the new response shape; keep the failure logging just added). `portal` unchanged.
- **`preload.ts` + `apps/web/src/lib/desktop.ts`** — update the `billing.checkout` return type to `{ clientSecret: string; publishableKey: string } | null`.
- **`setWindowOpenHandler`** — the embedded form is an iframe (fine), but a Stripe **wallet/3DS popup** could be denied. Allow-list `https://*.stripe.com` / `https://hooks.stripe.com` to open (either in-app or via `shell.openExternal`) instead of a blanket deny. (Low risk; card 3DS renders inline — this is belt-and-suspenders.)

### web (renderer)

- **Deps:** add `@stripe/stripe-js` + `@stripe/react-stripe-js` to `apps/web`.
- **`AccountModal.tsx`** — add an in-modal checkout view state:
  - Clicking "Upgrade to Pro" calls `account.upgrade(personalOrgId)`, which now returns `{ clientSecret, publishableKey }`; store it in state and switch the modal body to the checkout view.
  - Checkout view: a small header ("Upgrade to Pro" + a Back/Cancel button that returns to the account view) and `<EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret, onComplete }}><EmbeddedCheckout/></EmbeddedCheckoutProvider>`.
  - `stripePromise = loadStripe(publishableKey)` — memoized once per publishableKey (do NOT call `loadStripe` on every render).
  - `onComplete`: call `account.refreshBilling()`, show a brief "You're on Pro" success state, then return to the account view. If entitlement hasn't flipped yet (Stripe activation lag), a single delayed re-`refreshBilling()` (~1.5s) covers it; the provider's `onChanged` re-emit also refetches.
  - Loading/error: while awaiting the clientSecret, show a spinner; if `upgrade()` returns null (the checkout call failed — the logging names why), show an inline error with a retry, not a dead click.
- **`useAccount.ts` `upgrade`** — return type becomes `{ clientSecret: string; publishableKey: string } | null` (it already just forwards `rigel.billing.checkout`).

## Electron / CSP

No CSP is currently set (no `<meta>` in `index.html`, no `onHeadersReceived`), so Stripe.js and the Stripe iframes load without CSP changes. If a CSP is ever added, it must allow: `script-src https://js.stripe.com`, `frame-src https://js.stripe.com https://*.stripe.com https://hooks.stripe.com`, `connect-src https://api.stripe.com`. Note this here so a future CSP doesn't silently break checkout.

## Provisioning / entitlement timing

Entitlement is derived from Stripe `activeEntitlements` (the subscription's features). After `onComplete` the subscription is paid; features should be active within moments. Refetch on `onComplete` (+ one delayed retry) is the v1 approach. A Stripe **webhook** for robust provisioning is out of scope (the desktop-driven refetch is sufficient for a desktop-first product).

## Testing

- **signups (vitest):** `createCheckoutSession` passes `ui_mode:'embedded'` + `redirect_on_completion:'never'` and returns `client_secret`; `POST /billing/checkout` returns `{ clientSecret, publishableKey }`; boot guard flags a pk/sk mode mismatch. (Stripe client is the injected fake, as today.)
- **desktop (vitest):** `billingClient.checkout` parses the new shape; the IPC handler returns it without opening a window.
- **web (vitest):** AccountModal enters the checkout view on upgrade (mock `upgrade` → clientSecret), and returns to the account view + calls `refreshBilling` on `onComplete`. Mock `@stripe/react-stripe-js` (don't load real Stripe.js in unit tests).
- **Manual (local compose backend):** click Upgrade → embedded form renders in the modal → pay with `4242…` → returns to Pro. Verified against the local test-mode backend.

## Out of scope (v1)

- Embedding the **Customer Portal** (stays a hosted window).
- Stripe **webhooks** for provisioning (desktop refetch is the mechanism).
- Wallets/Apple Pay tuning beyond what Embedded Checkout gives by default.

## Slices

- **EC1 — backend:** embedded session + `{ clientSecret, publishableKey }` + `STRIPE_PUBLISHABLE_KEY` env/guard/docs.
- **EC2 — desktop bridge:** checkout returns the new shape end-to-end (billingClient → main → preload → web bridge), no window; stripe popup allow-list.
- **EC3 — web modal:** deps + the in-modal EmbeddedCheckout view + `onComplete` refetch + loading/error states.
