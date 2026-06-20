# Certificates panel (cert-manager) — design

**Date:** 2026-06-14
**Status:** Approved — ready for implementation plan
**Scope:** One new read+act panel in `apps/web` surfacing cert-manager's ACME
issuance pipeline (Certificates, CertificateRequests, Orders, Challenges), with
actions to cancel orders/challenges and re-initialize a TLS certificate.

## Goal

Give Helmsman a Rancher-equivalent view of cert-manager resources: see
certificates and their issuance state, drill into the
CertificateRequest → Order → Challenge chain, and take corrective action
(cancel a stuck order/challenge, force a renew, or delete the cert's secret) to
re-initialize a TLS certificate.

This is **web-only** — there is no cert-manager equivalent anywhere in the Swift
app, so this is a net-new addition (Rancher parity), not a Swift port.

## Decisions (from brainstorming)

- **Structure:** a single **Certificates** panel. Certs are the rows; expanding a
  cert shows its full issuance chain inline (CertificateRequest → Order →
  Challenge) with actions in place. Chosen over three separate Rancher-style
  panels because the whole point is the "re-initialize one cert" workflow, which
  wants everything for a cert in one place.
- **Actions (all four):** Cancel/delete Order, Cancel/delete Challenge, Force
  renew certificate, Delete cert's Secret.
- **Nav:** a new **"Security & Certs"** group in the left nav.
- **Force renew mechanism:** the official `kubectl cert-manager renew` plugin
  (cmctl), **baked into the Docker image** the same way `kubectl-cnpg` is.
  Delete Secret is the always-available, kubectl-only re-issue path when cmctl is
  absent.

## Why this is cheap to build

The existing infrastructure already covers reads and deletes generically:

- **Reads:** `WatchManager.start()` runs `kubectl get <kind> --watch
  --output-watch-events -o json` with `kind` passed straight through. cert-manager
  CRDs flow through the identical path the Services/Ingresses panels use — no
  server watch changes. The client Zustand store (`store/cluster.ts`) keys
  resources by arbitrary `kind` strings, so no store changes either.
- **Deletes:** `resolveDeleteResource()` in `apps/server/src/actions.ts` maps a
  resource kind → `kubectl delete <kind> <name> -n <ns>`, routed through the
  standard confirm Sheet. Cancelling an order/challenge is a delete of that CRD.
- **Force renew:** the generic `command` action kind already builds arbitrary
  kubectl argv (used today for `cnpg` plugin commands). No new action kind.

## CRD names

Use fully-qualified names everywhere (watch subscriptions + delete argv) to avoid
ambiguity with any other `certificates`/`orders` resources in the cluster:

- `certificates.cert-manager.io`
- `certificaterequests.cert-manager.io`
- `orders.acme.cert-manager.io`
- `challenges.acme.cert-manager.io`

## Architecture

Mirrors the Ingresses panel layout exactly.

```
apps/web/src/panels/certificates/
  CertificatesPanel.tsx        # panel UI: rows + expanded chain + action buttons
  certificatesDisplay.ts       # PURE join/derive/format logic (the core)
  certificatesDisplay.test.ts  # unit tests for the join + derivations
  types.ts                     # Certificate / CertificateRequest / Order / Challenge shapes
```

- The panel subscribes to all four kinds via the existing WS `subscribe(kind,
  ns)` on mount (respecting `namespaceFilter`), and unsubscribes on unmount.
- It reads the four live lists from the store and calls `certificatesDisplay.ts`
  to assemble per-certificate view models.
- Nav wiring in `apps/web/src/shell/NavStrip.tsx`:
  - Add `certificates` to `PANEL_META` (route `/certificates`, title
    "Certificates", subtitle "TLS & cert-manager", a ShieldCheck-family icon).
  - Add a new `NAV_GROUPS` entry `{ title: "Security & Certs", panels:
    ["certificates"] }`.
  - Register the route in the router alongside the other panels.

## The chain join (core of `certificatesDisplay.ts`)

All correlation is pure and unit-tested. Inputs are the four raw lists from the
store; output is a list of `CertView` objects (one per Certificate).

- **Certificate → CertificateRequests:** match by the
  `cert-manager.io/certificate-name` annotation on the CR (plus same namespace).
  A cert may have multiple CRs over time; show them newest-first, surface the
  latest prominently.
- **CertificateRequest → Order:** the Order's `ownerReferences[].uid` equals the
  CR's `metadata.uid`.
- **Order → Challenges:** each Challenge's `ownerReferences[].uid` equals the
  Order's `metadata.uid`.

Per-certificate derivations:

- **Ready:** `status.conditions[?type=="Ready"].status == "True"`.
- **Issuing:** `status.conditions[?type=="Issuing"].status == "True"` (or any
  in-flight CR/Order/Challenge present).
- **Expiry:** `status.notAfter` rendered as relative age (e.g. "exp 67d"); also
  `status.renewalTime` if useful.
- **DNS names / issuer / secretName:** from `spec.dnsNames`, `spec.issuerRef`,
  `spec.secretName`.

Edge cases the tests must cover:

- Orphan CR/Order/Challenge (owner ref points at something not in the list) →
  excluded from any cert's chain, never crashes.
- Multiple CRs for one cert → all attached, ordered newest-first.
- Missing `ownerReferences` / missing annotations → handled, no throw.
- Cert with no CRs (steady-state Ready) → empty chain, row still renders.

## Row UX

- **Collapsed row** (mirrors the Ingress row two-line style): name · namespace
  pill · Ready/Issuing status pill · expiry. Failed/issuing certs visually
  distinct (amber/red accent like the rest of the app).
- **Expanded detail:**
  - **Issuance chain** section: CertificateRequest → Order → Challenge, each with
    its state and `reason`/message. Challenges show the ACME type
    (`http-01`/`dns-01`) and the authorization domain.
  - **Details** section: DNS names, issuer ref, secret name, not-after, age.
  - Inline action buttons (see below) on the relevant chain nodes.

## Actions (every one goes through the standard confirm Sheet)

The confirm Sheet shows the EXACT kubectl command before running — no mutation
without it (per `apps/CLAUDE.md`).

1. **Cancel Order** — extend `resolveDeleteResource` to map `order` →
   `delete orders.acme.cert-manager.io <name> -n <ns>`. cert-manager recreates
   the order and retries issuance.
2. **Cancel Challenge** — extend `resolveDeleteResource` to map `challenge` →
   `delete challenges.acme.cert-manager.io <name> -n <ns>`.
3. **Delete cert's Secret** — `resolveDeleteResource` already handles `secret`;
   wire the button to delete `spec.secretName`. Aggressive: removes the serving
   cert and forces full re-issuance.
4. **Force renew certificate** — existing `command` action with args
   `["cert-manager","renew","<cert>","-n","<ns>"]`. The `kubectl cert-manager`
   plugin (cmctl) is baked into the Dockerfile; `--context` is inserted **after**
   the plugin name by the existing plugin-arg handling (same path as `cnpg`).

These map onto the action-block / confirm-sheet contract already used by the rest
of the web app — the panel raises the same action shapes the chat path uses.

## cmctl in the image

- Add the cert-manager `kubectl` plugin (`cmctl` / `kubectl-cert_manager`) to the
  `Dockerfile`, alongside the existing `kubectl-cnpg` install.
- Add `cert-manager` to the server's known-plugin list so `--context` is placed
  after the plugin name (mirrors the cnpg handling).
- Optional probe `GET /api/cert-manager-plugin` (mirrors `/api/cnpg-plugin`,
  runs `kubectl cert-manager version`): when it fails, the Force-renew button is
  disabled with a tooltip ("cmctl not available"). Delete Secret remains as the
  kubectl-only re-issue path.

## Edge cases / failure modes

- **cert-manager not installed:** the four watches yield empty snapshots (the
  `kubectl get <crd>` process exits; `WatchManager` does not respawn, so there is
  no error loop). The panel shows a friendly empty state: "No certificates found
  — cert-manager may not be installed."
- **Namespace filter:** respects the shared `namespaceFilter` exactly like other
  panels (subscribe with the selected ns or `*`).

## Testing

- `certificatesDisplay.test.ts`: chain join (orphans, multiple CRs, missing owner
  refs, empty chain), Ready/Issuing derivation, expiry formatting.
- `actions.test.ts`: new `resolveDeleteResource` cases for `order` and
  `challenge` mapping to the fully-qualified `delete` argv; confirm the
  force-renew `command` argv shape.
- Build/typecheck: `pnpm --filter web build`, `pnpm --filter web typecheck`,
  `pnpm --filter web test`, `pnpm --filter @rigel/server test`.
- Rebuild the Docker container after the web change (`docker compose up -d
  --build`) so the running app — and the baked cmctl plugin — are updated.

## Out of scope

- Editing/creating Certificates or Issuers (read + corrective-action only).
- ClusterIssuer/Issuer management panels.
- Three-separate-panel Rancher layout (explicitly rejected in favor of the nested
  chain).
- Any Swift-side equivalent.

## Follow-ups (per user's global workflow)

- Update the app's Outline doc with the Certificates panel.
- Derive Plane tickets from that doc.
