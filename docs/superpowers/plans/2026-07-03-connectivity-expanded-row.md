# Connectivity Expanded Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dead expand chevron on each Connectivity flow row functional — expanding a row reveals the flow's routing and backing pods (with per-pod ready status).

**Architecture:** Enrich the pure `computeFlows` model so each `Flow` carries a `pods: FlowPod[]` array (replacing `podNames`). A new `ConnectivityDetail` component renders inside the shared `ListRow.expandedContent`, following the existing "expanded row (improved)" pattern (`MetaCard`/`SectionLabel`). `ConnectivityPanel` gains real per-row expansion state so the chevron and `aria-expanded` become live. No server changes, no mutations.

**Tech Stack:** React 19, TypeScript, Tailwind v4, Vitest + @testing-library/react, react-router v7. Path alias `@/` → `apps/web/src`.

---

## File Structure

- Modify `apps/web/src/panels/connectivity/types.ts` — add `FlowPod`, replace `Flow.podNames` with `Flow.pods`.
- Modify `apps/web/src/panels/connectivity/connectivityDisplay.ts` — build `pods` in `computeFlows`.
- Modify `apps/web/src/panels/connectivity/connectivityDisplay.test.ts` — `podNames` → `pods` assertions + a mixed-readiness case.
- Create `apps/web/src/panels/connectivity/ConnectivityDetail.tsx` — the expanded-row body.
- Create `apps/web/src/panels/connectivity/ConnectivityDetail.test.tsx` — light render test.
- Modify `apps/web/src/panels/connectivity/ConnectivityPanel.tsx` — expansion state + wire `FlowRow`.

---

## Task 1: Enrich the Flow model with per-pod status

**Files:**
- Modify: `apps/web/src/panels/connectivity/types.ts`
- Modify: `apps/web/src/panels/connectivity/connectivityDisplay.ts`
- Modify: `apps/web/src/panels/connectivity/connectivityDisplay.test.ts`
- Modify: `apps/web/src/panels/connectivity/ConnectivityPanel.tsx:224` (the `podNames[0]` consumer)

- [ ] **Step 1: Update the test assertions to the new `pods` shape (failing test)**

In `connectivityDisplay.test.ts`, replace the three `podNames` assertions and add one new test.

Line ~128 (in "basic external flow"): replace
```ts
    expect(f.podNames).toEqual(["api-1"]);
```
with
```ts
    expect(f.pods).toEqual([{ name: "api-1", ready: true, phase: "Running" }]);
```

Lines ~226 and ~228 (in "namespace isolation"): replace
```ts
    expect(byNs.default.podNames).toEqual(["api-d"]);
    expect(byNs.prod.id).toBe("prod/api");
    expect(byNs.prod.podNames).toEqual(["api-p"]);
```
with
```ts
    expect(byNs.default.pods.map((p) => p.name)).toEqual(["api-d"]);
    expect(byNs.prod.id).toBe("prod/api");
    expect(byNs.prod.pods.map((p) => p.name)).toEqual(["api-p"]);
```

Add this new test at the end of the `describe("computeFlows", …)` block, before its closing `});`:
```ts
  it("pods carry per-pod ready flag and phase, sorted by name", () => {
    const flows = computeFlows(
      [],
      [service("api", "default", { app: "api" })],
      [
        pod("api-2", "default", { app: "api" }, { ready: [false] }),
        pod("api-1", "default", { app: "api" }, { ready: [true] }),
        pod("api-3", "default", { app: "api" }, { phase: "Pending" }),
      ],
    );
    expect(flows).toHaveLength(1);
    expect(flows[0].pods).toEqual([
      { name: "api-1", ready: true, phase: "Running" },
      { name: "api-2", ready: false, phase: "Running" },
      { name: "api-3", ready: false, phase: "Pending" },
    ]);
    expect(flows[0].readyPods).toBe(1);
    expect(flows[0].totalPods).toBe(3);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web test -- connectivityDisplay`
Expected: FAIL — `f.pods` is undefined / property `pods` does not exist on type `Flow`.

- [ ] **Step 3: Add the `FlowPod` type and swap `podNames` → `pods` in `types.ts`**

In `apps/web/src/panels/connectivity/types.ts`, add the `FlowPod` interface above `Flow`:
```ts
/** A pod backing a flow's service, with its readiness derived at compute time. */
export interface FlowPod {
  /** Pod name. */
  name: string;
  /** True iff Running with all containers ready (isPodReady). */
  ready: boolean;
  /** Pod phase (e.g. "Running", "Pending"); "Unknown" when absent. */
  phase: string;
}
```

In the same file, inside `interface Flow`, replace:
```ts
  /** Matching pod names (sorted). */
  podNames: string[];
```
with:
```ts
  /** Matching pods (sorted by name), each with derived readiness + phase. */
  pods: FlowPod[];
```

- [ ] **Step 4: Build the `pods` array in `computeFlows`**

In `apps/web/src/panels/connectivity/connectivityDisplay.ts`:

Add `FlowPod` to the type import at the top:
```ts
import type { Flow, FlowPod, Health } from "./types";
```

In the service-flow branch, after the `const ready = matched.filter(isPodReady).length;` line, add:
```ts
    const flowPods: FlowPod[] = matched
      .map((p) => ({
        name: p.metadata.name,
        ready: isPodReady(p),
        phase: p.status?.phase ?? "Unknown",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
```

In the `finalizeFlow({ … })` call for the service flow, replace:
```ts
        podNames: matched.map((p) => p.metadata.name).sort((a, b) => a.localeCompare(b)),
```
with:
```ts
        pods: flowPods,
```

In the dangling-ingress `finalizeFlow({ … })` call, replace:
```ts
        podNames: [],
```
with:
```ts
        pods: [],
```

- [ ] **Step 5: Update the one `podNames` consumer in the panel**

In `apps/web/src/panels/connectivity/ConnectivityPanel.tsx`, inside `handleSelectPods`, replace:
```ts
    const firstName = flow.podNames[0];
    if (!firstName) return;
```
with:
```ts
    const firstName = flow.pods[0]?.name;
    if (!firstName) return;
```

- [ ] **Step 6: Run tests + typecheck to verify green**

Run: `pnpm --filter web test -- connectivityDisplay`
Expected: PASS (all `computeFlows` tests including the new one).

Run: `pnpm --filter web typecheck`
Expected: no errors (no remaining `podNames` references).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/panels/connectivity/types.ts apps/web/src/panels/connectivity/connectivityDisplay.ts apps/web/src/panels/connectivity/connectivityDisplay.test.ts apps/web/src/panels/connectivity/ConnectivityPanel.tsx
git commit -m "feat(connectivity): carry per-pod ready/phase on Flow (HELM-34)"
```

---

## Task 2: Build the `ConnectivityDetail` expanded-row component

**Files:**
- Create: `apps/web/src/panels/connectivity/ConnectivityDetail.tsx`
- Create: `apps/web/src/panels/connectivity/ConnectivityDetail.test.tsx`

- [ ] **Step 1: Write the failing render test**

Create `apps/web/src/panels/connectivity/ConnectivityDetail.test.tsx`:
```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ConnectivityDetail } from "./ConnectivityDetail";
import type { Flow } from "./types";

function flow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: "default/api",
    hosts: ["example.com"],
    ingressNames: ["web"],
    serviceName: "api",
    namespace: "default",
    serviceType: "ClusterIP",
    serviceExists: true,
    readyPods: 1,
    totalPods: 2,
    pods: [
      { name: "api-1", ready: true, phase: "Running" },
      { name: "api-2", ready: false, phase: "Pending" },
    ],
    isExternal: true,
    issues: [],
    health: "ok",
    ...overrides,
  };
}

function renderDetail(f: Flow) {
  return render(
    <MemoryRouter>
      <ConnectivityDetail flow={f} />
    </MemoryRouter>,
  );
}

describe("ConnectivityDetail", () => {
  it("lists each backing pod by name", () => {
    renderDetail(flow());
    expect(screen.getByText("api-1")).toBeTruthy();
    expect(screen.getByText("api-2")).toBeTruthy();
  });

  it("shows the ingress host → ingress route for external flows", () => {
    renderDetail(flow());
    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.getByText("web")).toBeTruthy();
  });

  it("shows an empty state when the service is missing", () => {
    renderDetail(
      flow({ serviceExists: false, pods: [], readyPods: 0, totalPods: 0, issues: ["Ingress points to a service that doesn't exist"] }),
    );
    expect(screen.getByText("Service does not exist")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter web test -- ConnectivityDetail`
Expected: FAIL — cannot resolve `./ConnectivityDetail` (module does not exist).

- [ ] **Step 3: Implement `ConnectivityDetail`**

Create `apps/web/src/panels/connectivity/ConnectivityDetail.tsx`:
```tsx
import { Globe, Lock, Network, Signpost, ArrowRight } from "lucide-react";
import { useNavigate } from "react-router";
import { goToResource } from "@/lib/resourceNav";
import { MetaCard, SectionLabel } from "@/panels/components/MetaCard";
import type { Flow, FlowPod } from "./types";

// ---------------------------------------------------------------------------
// Expanded row body for a connectivity Flow. Renders inside the shared ListRow
// expanded wrapper (which supplies the surrounding padding + background).
// Read-only: every element either displays derived flow data or navigates to
// another panel. NO mutations. Follows the "expanded row (improved)" pattern
// (MetaCard/SectionLabel), mirroring ConfigMaps/Services.
// ---------------------------------------------------------------------------

// Health → color token, matching FlowRow's healthColor mapping.
function healthColor(health: Flow["health"]): string {
  return health === "ok"
    ? "var(--status-running)"
    : health === "warn"
      ? "var(--status-pending)"
      : "var(--status-failed)";
}

// A pod's status dot color: green when ready, else pending/failed by phase.
function podDotColor(p: FlowPod): string {
  if (p.ready) return "var(--status-running)";
  return p.phase === "Failed" ? "var(--status-failed)" : "var(--status-pending)";
}

export function ConnectivityDetail({ flow }: { flow: Flow }) {
  const navigate = useNavigate();

  function goPod(name: string) {
    goToResource(navigate, {
      kind: "pods",
      name,
      namespace: flow.namespace,
      key: `${flow.namespace}/${name}`,
      status: "ok",
    });
  }

  function goIngress(name: string) {
    goToResource(navigate, {
      kind: "ingresses",
      name,
      namespace: flow.namespace,
      key: `${flow.namespace}/${name}`,
      status: "ok",
    });
  }

  return (
    <div className="flex flex-col gap-[18px]">
      {/* Meta strip: ROUTE / SERVICE / ENDPOINTS */}
      <div className="flex gap-3">
        <MetaCard label="ROUTE">
          <div className="flex items-center gap-[7px]">
            {flow.isExternal ? (
              <Globe className="size-[13px] text-[var(--fg-tertiary)]" />
            ) : (
              <Lock className="size-[13px] text-[var(--fg-tertiary)]" />
            )}
            <span className="font-mono text-[13px] text-[var(--fg-secondary)]">
              {flow.isExternal
                ? flow.hosts.length > 0
                  ? flow.hosts.join(", ")
                  : "(no host)"
                : "cluster (internal)"}
            </span>
          </div>
        </MetaCard>

        <MetaCard label="SERVICE">
          <div className="flex items-center gap-[7px]">
            <Network
              className="size-[13px]"
              style={{ color: flow.serviceExists ? "var(--fg-tertiary)" : "var(--status-failed)" }}
            />
            <span
              className="font-mono text-[13px]"
              style={{ color: flow.serviceExists ? "var(--fg-secondary)" : "var(--status-failed)" }}
            >
              {flow.serviceExists ? `svc/${flow.serviceName} · ${flow.serviceType}` : "missing"}
            </span>
          </div>
        </MetaCard>

        <MetaCard label="ENDPOINTS">
          <div className="flex items-baseline gap-1.5">
            <span
              className="text-[18px] font-bold leading-none"
              style={{ color: healthColor(flow.health) }}
            >
              {flow.readyPods}/{flow.totalPods}
            </span>
            <span className="text-[13px] text-[var(--fg-tertiary)]">ready</span>
          </div>
        </MetaCard>
      </div>

      {/* Ingress routes — external flows only */}
      {flow.isExternal && flow.ingressNames.length > 0 && (
        <div className="flex flex-col gap-[9px]">
          <SectionLabel>ROUTES</SectionLabel>
          <div className="flex flex-col gap-1">
            {flow.ingressNames.map((ing) => (
              <button
                key={ing}
                type="button"
                onClick={() => goIngress(ing)}
                className="flex items-center gap-2 rounded px-1 py-0.5 text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="font-mono text-[13px] text-[var(--fg-secondary)]">
                  {flow.hosts.length > 0 ? flow.hosts.join(", ") : "(no host)"}
                </span>
                <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                <Signpost className="size-3.5 text-muted-foreground" aria-hidden />
                <span className="font-mono text-[13px] text-[var(--fg-secondary)]">{ing}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Backing pods */}
      <div className="flex flex-col gap-[9px]">
        <SectionLabel>{`PODS · ${flow.totalPods}`}</SectionLabel>
        {flow.pods.length === 0 ? (
          <p className="text-xs text-[var(--fg-tertiary)]">
            {flow.serviceExists ? "No pods match this service" : "Service does not exist"}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {flow.pods.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => goPod(p.name)}
                className="flex items-center gap-2 rounded px-1 py-1 text-left hover:bg-white/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  className="size-[7px] shrink-0 rounded-full"
                  style={{ background: podDotColor(p) }}
                  aria-hidden
                />
                <span className="font-mono text-[13px] text-[var(--fg-secondary)]">{p.name}</span>
                <span className="flex-1" />
                <span className="font-mono text-[11px] text-[var(--fg-tertiary)]">{p.phase}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Issues */}
      {flow.issues.length > 0 && (
        <div className="flex flex-col gap-[9px]">
          <SectionLabel>ISSUES</SectionLabel>
          <p
            className="font-mono text-xs"
            style={{ color: healthColor(flow.health) }}
          >
            {flow.issues.join(" · ")}
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter web test -- ConnectivityDetail`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/connectivity/ConnectivityDetail.tsx apps/web/src/panels/connectivity/ConnectivityDetail.test.tsx
git commit -m "feat(connectivity): ConnectivityDetail expanded-row body (HELM-34)"
```

---

## Task 3: Wire real expansion into `ConnectivityPanel`

**Files:**
- Modify: `apps/web/src/panels/connectivity/ConnectivityPanel.tsx`

- [ ] **Step 1: Import `useState` and `ConnectivityDetail`**

At the top of `ConnectivityPanel.tsx`, change:
```ts
import { useEffect, useMemo } from "react";
```
to:
```ts
import { useEffect, useMemo, useState } from "react";
```

Add, alongside the other local imports (e.g. after the `computeFlows` import):
```ts
import { ConnectivityDetail } from "./ConnectivityDetail";
```

- [ ] **Step 2: Add expansion state + toggle in `ConnectivityPanel`**

Inside `ConnectivityPanel`, after the `namespaceFilter` selector line, add:
```ts
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
```

- [ ] **Step 3: Pass expansion props to each `FlowRow`**

In the `external.map(...)` and `internal.map(...)` blocks, change each:
```tsx
                  <FlowRow key={f.id} flow={f} />
```
to:
```tsx
                  <FlowRow
                    key={f.id}
                    flow={f}
                    isOpen={expanded.has(f.id)}
                    onToggle={() => toggleExpand(f.id)}
                  />
```
(There are two such call sites — External and Internal. Update both.)

- [ ] **Step 4: Make `FlowRow` consume the props and render expanded content**

Change the `FlowRow` signature from:
```tsx
function FlowRow({ flow }: { flow: Flow }) {
```
to:
```tsx
function FlowRow({
  flow,
  isOpen,
  onToggle,
}: {
  flow: Flow;
  isOpen: boolean;
  onToggle: () => void;
}) {
```

In the same component, change the `ListRow` opening props from:
```tsx
    <ListRow
      rowKey={flow.id}
      isOpen={false}
      onToggle={() => {}}
      contextMenu={rowMenu}
    >
```
to:
```tsx
    <ListRow
      rowKey={flow.id}
      isOpen={isOpen}
      onToggle={onToggle}
      contextMenu={rowMenu}
      expandedContent={<ConnectivityDetail flow={flow} />}
    >
```

- [ ] **Step 5: Run typecheck + the connectivity tests**

Run: `pnpm --filter web typecheck`
Expected: no errors.

Run: `pnpm --filter web test -- connectivity`
Expected: PASS (connectivityDisplay + ConnectivityDetail suites).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/connectivity/ConnectivityPanel.tsx
git commit -m "feat(connectivity): make the flow-row chevron expand pods + routes (HELM-34)"
```

---

## Task 4: Full verification

- [ ] **Step 1: Run the whole web test suite + typecheck + build**

Run: `pnpm --filter web test`
Expected: PASS (whole suite green).

Run: `pnpm --filter web typecheck`
Expected: no errors.

Run: `pnpm --filter web build`
Expected: build succeeds.

- [ ] **Step 2: Manual smoke (optional, only if asked to run the app)**

Per project convention, do NOT start a web dev server. If a live check is requested, use `pnpm --filter desktop dev`, open the Connectivity tab, click a flow row's chevron, and confirm the meta strip, routes, and per-pod status list appear and that pod/ingress links navigate.

---

## Out of scope

- Port-forward UI, View YAML, Ask Claude handoff (already deferred in the panel).
- Any mutation / write path.
- Filtering or grouping controls — the chevron is a per-row disclosure, not a filter.

## Post-implementation (per user's global workflow)

- Update the app's Outline docs for the Connectivity tab to note the new expandable rows.
- Move HELM-34 to done in Plane once merged.
