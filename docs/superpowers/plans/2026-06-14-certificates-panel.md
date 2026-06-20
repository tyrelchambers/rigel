# Certificates Panel (cert-manager) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single web "Certificates" panel that surfaces cert-manager's Certificates with their inline CertificateRequest → Order → Challenge chain, and lets the user cancel orders/challenges, force a renew, or delete the cert's Secret to re-initialize a TLS certificate.

**Architecture:** Mirrors the existing Ingresses panel. The panel subscribes to four cert-manager CRDs over the existing generic WebSocket watch (no server watch changes), joins them with pure logic in `certificatesDisplay.ts`, and renders rows + an expandable issuance chain. Mutations reuse the existing `ConfirmSheet` + `ActionBlock` path: deletes via the generic `deleteResource` action (resolver extended for order/challenge), and force-renew via the existing generic `command` action calling the `kubectl cert-manager` (cmctl) plugin baked into the Docker image.

**Tech Stack:** React 19 + Vite + TypeScript, Tailwind v4, Zustand store, Bun server, vitest (web) / bun test (server).

---

## File Structure

- Create `apps/web/src/panels/certificates/types.ts` — Certificate / CertificateRequest / Order / Challenge / CertView shapes.
- Create `apps/web/src/panels/certificates/certificatesDisplay.ts` — pure join + derive + format helpers.
- Create `apps/web/src/panels/certificates/certificatesDisplay.test.ts` — unit tests for the join + derivations.
- Create `apps/web/src/panels/certificates/CertificatesPanel.tsx` — panel UI.
- Modify `apps/web/src/shell/NavStrip.tsx` — `PANEL_META` entry + new `NAV_GROUPS` "Security & Certs" group.
- Modify `apps/web/src/App.tsx` — register `/certificates` route.
- Modify `apps/server/src/actions.ts` — extend `resolveDeleteResource` for `order` / `challenge`.
- Modify `apps/server/src/actions.test.ts` — cases for the new delete mappings.
- Modify `packages/k8s/src/run.ts` — add `cert-manager` to `KUBECTL_PLUGINS`.
- Modify `packages/k8s/src/run.test.ts` — case for the cert-manager plugin.
- Modify `apps/server/src/index.ts` — `GET /api/cert-manager-plugin` probe.
- Modify `apps/web/src/lib/api.ts` — `fetchCertManagerPlugin()` helper.
- Modify `Dockerfile` — install cmctl as `kubectl-cert_manager`.

CRD names used everywhere (fully-qualified to avoid ambiguity):
`certificates.cert-manager.io`, `certificaterequests.cert-manager.io`, `orders.acme.cert-manager.io`, `challenges.acme.cert-manager.io`.

---

## Task 1: Types

**Files:**
- Create: `apps/web/src/panels/certificates/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
// cert-manager resource shapes for the web Certificates panel. Net-new (no Swift
// equivalent). All four kinds are namespace-scoped. We only type the fields the
// panel reads — k8s objects carry far more.

export interface OwnerReference {
  uid: string;
  kind: string;
  name: string;
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid: string;
  creationTimestamp?: string; // ISO 8601
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
  ownerReferences?: OwnerReference[];
}

export interface Condition {
  type: string;   // "Ready" | "Issuing" | "Approved" | "Valid" | ...
  status: string; // "True" | "False" | "Unknown"
  reason?: string;
  message?: string;
}

export interface IssuerRef {
  name?: string;
  kind?: string; // "Issuer" | "ClusterIssuer"
  group?: string;
}

export interface Certificate {
  metadata: ObjectMeta;
  spec?: {
    dnsNames?: string[];
    secretName?: string;
    issuerRef?: IssuerRef;
  };
  status?: {
    conditions?: Condition[];
    notAfter?: string;     // ISO 8601
    notBefore?: string;
    renewalTime?: string;
  };
}

export interface CertificateRequest {
  metadata: ObjectMeta;
  status?: { conditions?: Condition[] };
}

export interface Order {
  metadata: ObjectMeta;
  status?: { state?: string; reason?: string };
}

export interface Challenge {
  metadata: ObjectMeta;
  spec?: { type?: string; dnsName?: string }; // type: "HTTP-01" | "DNS-01"
  status?: { state?: string; reason?: string; processing?: boolean; presented?: boolean };
}

/** A challenge node in the rendered chain. */
export interface ChallengeNode {
  name: string;
  namespace?: string;
  type: string;    // "HTTP-01" / "DNS-01" / "—"
  dnsName: string;
  state: string;   // status.state or "—"
  reason: string;
}

/** An order node, with its challenges. */
export interface OrderNode {
  name: string;
  namespace?: string;
  state: string;
  reason: string;
  challenges: ChallengeNode[];
}

/** A certificate request node, with its order (if any). */
export interface RequestNode {
  name: string;
  namespace?: string;
  ready: boolean;
  reason: string;
  order: OrderNode | null;
}

/** One certificate's full view model: row data + issuance chain. */
export interface CertView {
  cert: Certificate;
  name: string;
  namespace?: string;
  uid: string;
  ready: boolean;
  issuing: boolean;
  dnsNames: string[];
  issuer: string;       // "kind/name" or "—"
  secretName: string;   // "" when unset
  notAfter?: string;
  requests: RequestNode[]; // newest-first
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/panels/certificates/types.ts
git commit -m "feat(web/certificates): cert-manager resource + view-model types"
```

---

## Task 2: Pure display/join logic (TDD)

**Files:**
- Create: `apps/web/src/panels/certificates/certificatesDisplay.ts`
- Test: `apps/web/src/panels/certificates/certificatesDisplay.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import {
  isReady,
  isIssuing,
  issuerLabel,
  buildCertViews,
  matchesSearch,
  sortCertViews,
} from "./certificatesDisplay";
import type { Certificate, CertificateRequest, Order, Challenge } from "./types";

function cert(p: Partial<Certificate["metadata"]> & { name: string }, status?: Certificate["status"], spec?: Certificate["spec"]): Certificate {
  return { metadata: { uid: p.name + "-uid", namespace: "default", ...p }, spec, status };
}

describe("isReady / isIssuing", () => {
  it("reads the Ready condition", () => {
    expect(isReady(cert({ name: "a" }, { conditions: [{ type: "Ready", status: "True" }] }))).toBe(true);
    expect(isReady(cert({ name: "a" }, { conditions: [{ type: "Ready", status: "False" }] }))).toBe(false);
    expect(isReady(cert({ name: "a" }))).toBe(false);
  });
  it("reads the Issuing condition", () => {
    expect(isIssuing(cert({ name: "a" }, { conditions: [{ type: "Issuing", status: "True" }] }))).toBe(true);
    expect(isIssuing(cert({ name: "a" }))).toBe(false);
  });
});

describe("issuerLabel", () => {
  it("formats kind/name, falling back to dash", () => {
    expect(issuerLabel(cert({ name: "a" }, undefined, { issuerRef: { kind: "ClusterIssuer", name: "le" } }))).toBe("ClusterIssuer/le");
    expect(issuerLabel(cert({ name: "a" }))).toBe("—");
  });
});

describe("buildCertViews — chain join", () => {
  it("joins request → order → challenge by annotation + ownerReferences", () => {
    const c = cert({ name: "app-tls", uid: "cert-uid" }, { conditions: [{ type: "Issuing", status: "True" }] }, { dnsNames: ["app.example.com"], secretName: "app-tls" });
    const cr: CertificateRequest = {
      metadata: { name: "app-tls-1", uid: "cr-uid", namespace: "default", annotations: { "cert-manager.io/certificate-name": "app-tls" } },
      status: { conditions: [{ type: "Ready", status: "False", reason: "Pending" }] },
    };
    const order: Order = {
      metadata: { name: "app-tls-1-abc", uid: "order-uid", namespace: "default", ownerReferences: [{ uid: "cr-uid", kind: "CertificateRequest", name: "app-tls-1" }] },
      status: { state: "pending", reason: "" },
    };
    const ch: Challenge = {
      metadata: { name: "app-tls-1-abc-0", uid: "ch-uid", namespace: "default", ownerReferences: [{ uid: "order-uid", kind: "Order", name: "app-tls-1-abc" }] },
      spec: { type: "HTTP-01", dnsName: "app.example.com" },
      status: { state: "pending", reason: "waiting" },
    };

    const views = buildCertViews([c], [cr], [order], [ch]);
    expect(views).toHaveLength(1);
    const v = views[0]!;
    expect(v.name).toBe("app-tls");
    expect(v.issuing).toBe(true);
    expect(v.dnsNames).toEqual(["app.example.com"]);
    expect(v.requests).toHaveLength(1);
    expect(v.requests[0]!.order!.name).toBe("app-tls-1-abc");
    expect(v.requests[0]!.order!.challenges[0]!.type).toBe("HTTP-01");
    expect(v.requests[0]!.order!.challenges[0]!.state).toBe("pending");
  });

  it("attaches multiple requests newest-first and tolerates orphans", () => {
    const c = cert({ name: "x", uid: "x-uid" });
    const older: CertificateRequest = { metadata: { name: "x-1", uid: "cr1", namespace: "default", creationTimestamp: "2026-01-01T00:00:00Z", annotations: { "cert-manager.io/certificate-name": "x" } } };
    const newer: CertificateRequest = { metadata: { name: "x-2", uid: "cr2", namespace: "default", creationTimestamp: "2026-02-01T00:00:00Z", annotations: { "cert-manager.io/certificate-name": "x" } } };
    const orphanOrder: Order = { metadata: { name: "lost", uid: "o", namespace: "default", ownerReferences: [{ uid: "nope", kind: "CertificateRequest", name: "?" }] } };

    const views = buildCertViews([c], [older, newer], [orphanOrder], []);
    expect(views[0]!.requests.map((r) => r.name)).toEqual(["x-2", "x-1"]);
    expect(views[0]!.requests[0]!.order).toBeNull();
  });

  it("renders a Ready cert with no requests (empty chain)", () => {
    const c = cert({ name: "steady", uid: "s" }, { conditions: [{ type: "Ready", status: "True" }], notAfter: "2099-01-01T00:00:00Z" });
    const views = buildCertViews([c], [], [], []);
    expect(views[0]!.ready).toBe(true);
    expect(views[0]!.requests).toEqual([]);
  });
});

describe("matchesSearch / sortCertViews", () => {
  it("matches on name, namespace, dnsNames", () => {
    const c = cert({ name: "web-tls", namespace: "prod" }, undefined, { dnsNames: ["shop.example.com"] });
    const v = buildCertViews([c], [], [], [])[0]!;
    expect(matchesSearch(v, "shop")).toBe(true);
    expect(matchesSearch(v, "prod")).toBe(true);
    expect(matchesSearch(v, "nope")).toBe(false);
    expect(matchesSearch(v, "")).toBe(true);
  });
  it("sorts by namespace then name", () => {
    const a = buildCertViews([cert({ name: "b", namespace: "ns1" })], [], [], [])[0]!;
    const b = buildCertViews([cert({ name: "a", namespace: "ns2" })], [], [], [])[0]!;
    expect(sortCertViews([b, a]).map((v) => v.name)).toEqual(["b", "a"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test certificatesDisplay`
Expected: FAIL — module `./certificatesDisplay` not found / exports undefined.

- [ ] **Step 3: Write the implementation**

```typescript
import type {
  Certificate, CertificateRequest, Order, Challenge,
  CertView, RequestNode, OrderNode, ChallengeNode, Condition,
} from "./types";

// Re-export the shared relativeAge so the panel imports one age formatter.
export { relativeAge } from "../pods/podDisplay";

const CERT_NAME_ANNOTATION = "cert-manager.io/certificate-name";

function condition(conds: Condition[] | undefined, type: string): Condition | undefined {
  return (conds ?? []).find((c) => c.type === type);
}

/** True when the Ready condition is "True". */
export function isReady(cert: Certificate): boolean {
  return condition(cert.status?.conditions, "Ready")?.status === "True";
}

/** True when the Issuing condition is "True". */
export function isIssuing(cert: Certificate): boolean {
  return condition(cert.status?.conditions, "Issuing")?.status === "True";
}

/** "kind/name" or "—" when unset. */
export function issuerLabel(cert: Certificate): string {
  const ref = cert.spec?.issuerRef;
  if (!ref?.name) return "—";
  return ref.kind ? `${ref.kind}/${ref.name}` : ref.name;
}

function byUid(refs: { uid: string }[] | undefined, uid: string): boolean {
  return (refs ?? []).some((r) => r.uid === uid);
}

function newestFirst<T extends { metadata: { creationTimestamp?: string; name: string } }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ta = a.metadata.creationTimestamp ?? "";
    const tb = b.metadata.creationTimestamp ?? "";
    if (ta !== tb) return tb.localeCompare(ta);
    return a.metadata.name.localeCompare(b.metadata.name);
  });
}

function challengeNode(ch: Challenge): ChallengeNode {
  return {
    name: ch.metadata.name,
    namespace: ch.metadata.namespace,
    type: ch.spec?.type ?? "—",
    dnsName: ch.spec?.dnsName ?? "—",
    state: ch.status?.state ?? "—",
    reason: ch.status?.reason ?? "",
  };
}

function orderNode(order: Order, challenges: Challenge[]): OrderNode {
  return {
    name: order.metadata.name,
    namespace: order.metadata.namespace,
    state: order.status?.state ?? "—",
    reason: order.status?.reason ?? "",
    challenges: challenges
      .filter((ch) => byUid(ch.metadata.ownerReferences, order.metadata.uid))
      .map(challengeNode),
  };
}

function requestNode(cr: CertificateRequest, orders: Order[], challenges: Challenge[]): RequestNode {
  const order = orders.find((o) => byUid(o.metadata.ownerReferences, cr.metadata.uid)) ?? null;
  const ready = condition(cr.status?.conditions, "Ready");
  return {
    name: cr.metadata.name,
    namespace: cr.metadata.namespace,
    ready: ready?.status === "True",
    reason: ready?.reason ?? ready?.message ?? "",
    order: order ? orderNode(order, challenges) : null,
  };
}

/** Join certs ← requests ← orders ← challenges into per-cert view models. */
export function buildCertViews(
  certs: Certificate[],
  requests: CertificateRequest[],
  orders: Order[],
  challenges: Challenge[],
): CertView[] {
  return certs.map((cert) => {
    const myReqs = newestFirst(
      requests.filter(
        (cr) =>
          cr.metadata.namespace === cert.metadata.namespace &&
          cr.metadata.annotations?.[CERT_NAME_ANNOTATION] === cert.metadata.name,
      ),
    );
    return {
      cert,
      name: cert.metadata.name,
      namespace: cert.metadata.namespace,
      uid: cert.metadata.uid,
      ready: isReady(cert),
      issuing: isIssuing(cert) || myReqs.some((r) => !condition(undefined, "")), // placeholder replaced below
      dnsNames: cert.spec?.dnsNames ?? [],
      issuer: issuerLabel(cert),
      secretName: cert.spec?.secretName ?? "",
      notAfter: cert.status?.notAfter,
      requests: myReqs.map((cr) => requestNode(cr, orders, challenges)),
    };
  });
}

/** Case-insensitive match on name, namespace, and dnsNames. */
export function matchesSearch(v: CertView, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return (
    v.name.toLowerCase().includes(q) ||
    (v.namespace ?? "").toLowerCase().includes(q) ||
    v.dnsNames.some((d) => d.toLowerCase().includes(q))
  );
}

/** Sort by namespace then name. */
export function sortCertViews(views: CertView[]): CertView[] {
  return [...views].sort((a, b) => {
    const na = a.namespace ?? "";
    const nb = b.namespace ?? "";
    if (na !== nb) return na.localeCompare(nb);
    return a.name.localeCompare(b.name);
  });
}
```

> NOTE: the `issuing` line above contains a placeholder expression. Replace it with:
> `issuing: isIssuing(cert) || myReqs.some((r) => condition(r.status?.conditions, "Ready")?.status !== "True"),`
> (a cert is "issuing" when the Issuing condition is set OR any of its requests is not yet Ready). Keep it on one line.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test certificatesDisplay`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/certificates/certificatesDisplay.ts apps/web/src/panels/certificates/certificatesDisplay.test.ts
git commit -m "feat(web/certificates): pure cert-manager chain join + display helpers"
```

---

## Task 3: Server — cancel Order / Challenge delete mapping (TDD)

**Files:**
- Modify: `apps/server/src/actions.ts:101-121` (`resolveDeleteResource`)
- Test: `apps/server/src/actions.test.ts`

- [ ] **Step 1: Write the failing test** (append to `actions.test.ts`)

```typescript
test("deleteResource maps cert-manager order/challenge to fully-qualified delete", () => {
  expect(buildCommand({ kind: "deleteResource", resourceKind: "order", name: "app-tls-1-abc", namespace: "default" }))
    .toEqual(["delete", "orders.acme.cert-manager.io", "app-tls-1-abc", "-n", "default"]);
  expect(buildCommand({ kind: "deleteResource", resourceKind: "challenge", name: "app-tls-1-abc-0", namespace: "default" }))
    .toEqual(["delete", "challenges.acme.cert-manager.io", "app-tls-1-abc-0", "-n", "default"]);
  expect(buildCommand({ kind: "deleteResource", resourceKind: "certificaterequest", name: "app-tls-1", namespace: "default" }))
    .toEqual(["delete", "certificaterequests.cert-manager.io", "app-tls-1", "-n", "default"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun test src/actions.test.ts`
Expected: FAIL — currently maps to `["delete", "order", ...]` (short name), not the fully-qualified resource.

- [ ] **Step 3: Implement** — add aliases in `resolveDeleteResource` alongside the existing ones (after the `persistentvolumeclaim` line, before building `nsFlags`):

```typescript
  if (rk === "order") kubectl_kind = "orders.acme.cert-manager.io";
  if (rk === "challenge") kubectl_kind = "challenges.acme.cert-manager.io";
  if (rk === "certificaterequest") kubectl_kind = "certificaterequests.cert-manager.io";
  if (rk === "certificate") kubectl_kind = "certificates.cert-manager.io";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && bun test src/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/actions.ts apps/server/src/actions.test.ts
git commit -m "feat(server/actions): cert-manager order/challenge/CR delete mapping"
```

---

## Task 4: Server — register cert-manager as a kubectl plugin (TDD)

**Files:**
- Modify: `packages/k8s/src/run.ts:7` (`KUBECTL_PLUGINS`)
- Test: `packages/k8s/src/run.test.ts`

- [ ] **Step 1: Write the failing test** (append to `run.test.ts`)

```typescript
test("inserts --context AFTER the cert-manager plugin name", () => {
  expect(buildKubectlArgs("kind-test", ["cert-manager", "renew", "app-tls", "-n", "default"]))
    .toEqual(["cert-manager", "--context", "kind-test", "renew", "app-tls", "-n", "default"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/k8s && bun test src/run.test.ts`
Expected: FAIL — context prepended before `cert-manager`.

- [ ] **Step 3: Implement** — change the set in `run.ts`:

```typescript
const KUBECTL_PLUGINS = new Set(["cnpg", "cert-manager"]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/k8s && bun test src/run.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/run.ts packages/k8s/src/run.test.ts
git commit -m "feat(k8s): treat cert-manager (cmctl) as a kubectl plugin for --context placement"
```

---

## Task 5: Server probe + client helper for cmctl availability

**Files:**
- Modify: `apps/server/src/index.ts` (add route next to `/api/cnpg-plugin`, ~line 159)
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Add the server route** (immediately after the `/api/cnpg-plugin` block)

```typescript
    // GET /api/cert-manager-plugin — is the `kubectl cert-manager` plugin
    // (cmctl) installed? The Certificates panel uses this to enable/disable the
    // Force-renew action. `help` never touches the cluster, so exit 0 ⇒ present.
    // Always HTTP 200; { available:false } when the plugin is missing.
    if (url.pathname === "/api/cert-manager-plugin" && req.method === "GET") {
      const probe = await kubectl(context, ["cert-manager", "help"]);
      return Response.json({ available: probe.code === 0 });
    }
```

- [ ] **Step 2: Add the client helper** (in `apps/web/src/lib/api.ts`, near other GET helpers)

```typescript
/** Whether the `kubectl cert-manager` (cmctl) plugin is available on the server. */
export async function fetchCertManagerPlugin(): Promise<boolean> {
  const res = await fetch("/api/cert-manager-plugin");
  if (!res.ok) return false;
  const data = (await res.json()) as { available: boolean };
  return data.available;
}
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm --filter web typecheck && cd apps/server && bun build src/index.ts --target bun >/dev/null && echo OK`
Expected: `OK` (no type errors).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/index.ts apps/web/src/lib/api.ts
git commit -m "feat(server): /api/cert-manager-plugin probe + client helper"
```

---

## Task 6: CertificatesPanel UI

**Files:**
- Create: `apps/web/src/panels/certificates/CertificatesPanel.tsx`

Pattern: copy the structure of `apps/web/src/panels/ingresses/IngressesPanel.tsx` (PanelHeader + search, error banner, ListRow rows, expanded detail). Differences below.

- [ ] **Step 1: Write the panel**

Key behaviors (implement exactly):

1. **Subscribe to all four CRDs** on mount, re-subscribing when `namespaceFilter` changes:

```typescript
const KINDS = [
  "certificates.cert-manager.io",
  "certificaterequests.cert-manager.io",
  "orders.acme.cert-manager.io",
  "challenges.acme.cert-manager.io",
] as const;

useEffect(() => {
  const ns = namespaceFilter ?? "*";
  KINDS.forEach((k) => subscribe(k, ns));
  return () => KINDS.forEach((k) => unsubscribe(k, ns));
}, [namespaceFilter]);
```

2. **Build views from the store** (cast each map's values):

```typescript
const views = useMemo(() => {
  const certs = Object.values((resources["certificates.cert-manager.io"] ?? {}) as Record<string, Certificate>);
  const reqs = Object.values((resources["certificaterequests.cert-manager.io"] ?? {}) as Record<string, CertificateRequest>);
  const orders = Object.values((resources["orders.acme.cert-manager.io"] ?? {}) as Record<string, Order>);
  const challenges = Object.values((resources["challenges.acme.cert-manager.io"] ?? {}) as Record<string, Challenge>);
  return sortCertViews(buildCertViews(certs, reqs, orders, challenges));
}, [resources]);
const filtered = useMemo(() => views.filter((v) => matchesSearch(v, search)), [views, search]);
```

3. **Probe cmctl once** on mount to gate Force-renew:

```typescript
const [cmctlAvailable, setCmctlAvailable] = useState(false);
useEffect(() => { fetchCertManagerPlugin().then(setCmctlAvailable).catch(() => setCmctlAvailable(false)); }, []);
```

4. **Collapsed row**: name (mono button toggles expand) · namespace pill (reuse the inline pill style from IngressesPanel) · a Ready/Issuing status pill (green "Ready" when `v.ready`, amber "Issuing" when `v.issuing`, gray "—" otherwise) · expiry `exp {relativeAge(v.notAfter)}` when `v.notAfter` is set. Reuse `ListRow` with `expandedContent={<CertDetail view={v} onAction={setPendingAction} cmctlAvailable={cmctlAvailable} />}`.

5. **`pendingAction` state + ConfirmSheet** (same as NamespacesPanel):

```typescript
const [pendingAction, setPendingAction] = useState<ActionBlock | null>(null);
// ...at the end of the returned JSX:
<ConfirmSheet action={pendingAction} open={!!pendingAction} onClose={() => setPendingAction(null)} />
```

6. **`CertDetail` sub-component** renders, for each `view.requests` entry: the CertificateRequest (name + ready/reason), then its Order (name + state + reason) with a **Cancel order** button, then each Challenge (type · dnsName · state · reason) with a **Cancel challenge** button. Below the chain render a **Details** block (DNS names, issuer, secret, notAfter, age) and two cert-level action buttons: **Force renew** and **Delete secret**.

Action builders (each opens the ConfirmSheet via `onAction`):

```typescript
// Cancel an order
onAction({ kind: "deleteResource", resourceKind: "order", name: order.name, namespace: order.namespace, destructive: true, label: `Cancel order ${order.name}` });

// Cancel a challenge
onAction({ kind: "deleteResource", resourceKind: "challenge", name: ch.name, namespace: ch.namespace, destructive: true, label: `Cancel challenge ${ch.name}` });

// Delete the cert's secret (only render when view.secretName is non-empty)
onAction({ kind: "deleteResource", resourceKind: "secret", name: view.secretName, namespace: view.namespace, destructive: true, label: `Delete secret ${view.secretName}` });

// Force renew via cmctl (only enabled when cmctlAvailable; disabled button + title "cmctl not available" otherwise)
onAction({ kind: "command", args: ["cert-manager", "renew", view.name, "-n", view.namespace ?? "default"], destructive: true, label: `Renew certificate ${view.name}` });
```

7. **Empty states**: when `!isLoading && views.length === 0` show "No certificates found — cert-manager may not be installed." When `views.length > 0 && filtered.length === 0` show "No certificates match search."

8. **PanelHeader**: `title="Certificates"`, `subtitle="TLS & cert-manager"`, `count={filtered.length}`, `loading={isLoading}`, with the same search input as IngressesPanel.

Imports to use: `useCluster` from `@/store/cluster`; `subscribe, unsubscribe` from `@/lib/ws`; `ListRow` from `@/panels/components/ListRow`; `TagPill` from `@/panels/components/TagPill`; `PanelHeader` from `@/panels/components/PanelHeader`; `ConfirmSheet` from `@/components/ConfirmSheet`; `ActionBlock` from `@/lib/api`; `fetchCertManagerPlugin` from `@/lib/api`; the display helpers + types from `./certificatesDisplay` and `./types`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: no errors in `certificates/`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/panels/certificates/CertificatesPanel.tsx
git commit -m "feat(web/certificates): Certificates panel — rows, issuance chain, actions"
```

---

## Task 7: Nav + route wiring

**Files:**
- Modify: `apps/web/src/shell/NavStrip.tsx` (`PANEL_META`, `NAV_GROUPS`, icon import)
- Modify: `apps/web/src/App.tsx` (import + route)

- [ ] **Step 1: Add the icon import + PANEL_META entry** in `NavStrip.tsx`. Add `BadgeCheck` (or `FileBadge`) to the lucide import block, then add to `PANEL_META`:

```typescript
  certificates: { route: "/certificates", title: "Certificates", subtitle: "TLS & cert-manager", icon: BadgeCheck },
```

- [ ] **Step 2: Add the nav group** — insert into `NAV_GROUPS` after the "Cluster" group:

```typescript
  { title: "Security & Certs", panels: ["certificates"] },
```

- [ ] **Step 3: Register the route** in `App.tsx` — add the import near the other panel imports:

```typescript
import CertificatesPanel from "./panels/certificates/CertificatesPanel";
```

and the route alongside `/ingresses`:

```typescript
              <Route path="/certificates" element={<CertificatesPanel />} />
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/shell/NavStrip.tsx apps/web/src/App.tsx
git commit -m "feat(web): wire Certificates panel into nav (Security & Certs) + route"
```

---

## Task 8: Bake cmctl into the Docker image

**Files:**
- Modify: `Dockerfile` (the kubectl/helm/cnpg RUN block, ~lines 27-40)

- [ ] **Step 1: Add a cmctl install step** chained into the existing tools RUN, mirroring the resilient cnpg pattern (install as the kubectl plugin name `kubectl-cert_manager`). Use the latest cmctl release for linux; detect arch:

```dockerfile
 && (ARCH=$(dpkg --print-architecture) \
     && curl -sSfL "https://github.com/cert-manager/cmctl/releases/latest/download/cmctl_linux_${ARCH}.tar.gz" \
        | tar -xz -C /usr/local/bin cmctl \
     && ln -sf /usr/local/bin/cmctl /usr/local/bin/kubectl-cert_manager \
     || echo "cmctl install skipped (Force-renew will be disabled)") \
```

> If `cmctl_linux_${ARCH}.tar.gz` is not a tarball for the current release format, fall back to the raw binary asset `cmctl_linux_${ARCH}` written to `/usr/local/bin/cmctl` + `chmod +x`. The executing engineer should confirm the asset name against the latest cert-manager/cmctl release before finalizing.

- [ ] **Step 2: Commit** (build happens in Task 9)

```bash
git add Dockerfile
git commit -m "build: bake cmctl (kubectl cert-manager plugin) into the web image"
```

---

## Task 9: Full verification + container rebuild

- [ ] **Step 1: Run all affected test suites**

Run:
```bash
pnpm --filter web test
cd apps/server && bun test
cd ../../packages/k8s && bun test
```
Expected: all PASS.

- [ ] **Step 2: Typecheck + build web**

Run: `pnpm --filter web typecheck && pnpm --filter web build`
Expected: success.

- [ ] **Step 3: Rebuild the running container** (web runs as a local Docker container; typecheck/build alone won't update it, and the baked cmctl only lands on image rebuild)

Run: `docker compose up -d --build`
Expected: `rigel-web` rebuilt and healthy on :8787.

- [ ] **Step 4: Smoke-check the probe** (read-only)

Run: `curl -s localhost:8787/api/cert-manager-plugin`
Expected: `{"available":true}` (or `false` if cmctl didn't install — Force-renew will be disabled but the rest of the panel works).

- [ ] **Step 5: Final commit if anything changed during verification** (otherwise skip).

---

## Post-implementation (user's global workflow)

- Update the Rigel app's Outline doc with the new Certificates panel (features + actions).
- Derive Plane tickets from that doc (e.g. follow-ups: Issuer/ClusterIssuer view, ARM asset confirmation for cmctl).
