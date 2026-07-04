# Connectivity tab — wire up the flow-row expansion (HELM-34)

## Problem

Each flow row in the Connectivity tab
(`apps/web/src/panels/connectivity/ConnectivityPanel.tsx`) wraps its content in
the shared `ListRow`, which always renders an expand/collapse chevron. But the
panel passes `isOpen={false}` (hardcoded), `onToggle={() => {}}` (a no-op), and
no `expandedContent`. The result is a disclosure chevron that renders on every
row and does nothing when clicked — a dead affordance.

HELM-34 decision: **wire it up** so the chevron expands a flow row to reveal the
underlying pods and routing, giving real drill-down for diagnosing broken /
degraded flows.

## Approach

Follow the existing "expanded row (improved)" pattern already used by ConfigMaps
(Pencil frame xCFK3) and Services (x2MuTZ): shared `ListRow.expandedContent` +
`MetaCard`/`SectionLabel` from `panels/components/MetaCard.tsx`, with a per-panel
`ConnectivityDetail` component. No Pencil frame exists for Connectivity; we mirror
the established pattern directly rather than authoring a new design.

No server changes. No mutations. Read-only drill-down consistent with the panel's
current "NO mutations, NO kubectl writes" contract.

## Data model (Approach A — enrich the pure model)

In `connectivityDisplay.ts` `computeFlows`, the matched pod objects are already in
hand. Replace `Flow.podNames: string[]` with a richer per-pod array so the
expanded row can show each pod's status without re-deriving anything:

```ts
export interface FlowPod {
  name: string;
  ready: boolean;   // isPodReady(pod)
  phase: string;    // pod.status?.phase ?? "Unknown"
}

export interface Flow {
  // …unchanged fields…
  pods: FlowPod[];   // was: podNames: string[]  (sorted by name)
}
```

- `readyPods` / `totalPods` counts stay (derived from `pods`); they remain the
  source for the collapsed row's `readyPods/totalPods` chip.
- Dangling-ingress flows (service missing) keep `pods: []`.
- The single existing `podNames` consumer in `ConnectivityPanel.handleSelectPods`
  becomes `flow.pods[0]?.name`.
- `connectivityDisplay.test.ts` updates: assertions on `podNames` become
  assertions on `pods` (name + ready + phase).

Keeping the selector→pod matching and readiness logic in the pure, unit-tested
`connectivityDisplay.ts` preserves the single source of truth; `ConnectivityDetail`
only renders.

## `ConnectivityDetail` — expanded row body

New component `apps/web/src/panels/connectivity/ConnectivityDetail.tsx`, rendered
via `ListRow.expandedContent`. It receives the `Flow` and a navigate helper (or
does its own `useNavigate`), and renders four sections inside a
`flex flex-col gap-[18px]` container (ListRow's wrapper already provides padding
+ background):

1. **Meta strip** — `flex gap-3` row of `MetaCard`s:
   - `ROUTE` — external: `flow.hosts.join(", ")` (or "(no host)"); internal:
     "cluster (internal)".
   - `SERVICE` — `svc/{serviceName}` + `serviceType`; when `!serviceExists`,
     render "missing" tinted `var(--status-failed)`.
   - `ENDPOINTS` — `{readyPods}/{totalPods} ready`, tinted by health
     (reuse the row's `healthColor` mapping).

2. **Ingress routes** (only when `flow.isExternal`) — `SectionLabel` "ROUTES"
   then one line per host → fronting ingress name. Clicking navigates to the
   Ingresses panel via `goToResource({ kind: "ingresses", … })` focusing the
   ingress. (Hosts and ingress names are already sorted on the Flow.)

3. **Backing pods** — `SectionLabel` `PODS · {totalPods}`. When `pods` is empty:
   a muted line ("No pods match this service" / "Service does not exist" when
   `!serviceExists`). Otherwise one row per `FlowPod`:
   - status dot: `var(--status-running)` when `ready`, else
     `var(--status-pending)`/`var(--status-failed)` by phase;
   - mono pod name (clickable → Pods panel via existing `goToResource`,
     reusing `handleSelectPods`'s target shape but per-pod);
   - phase label, dim.

4. **Issues** (only when `flow.issues.length > 0`) — `SectionLabel` "ISSUES" then
   the `issues` joined/listed with the health tint (`HEALTH_TEXT[flow.health]`),
   matching the collapsed-row issues line so the "why" sits beside the pods.

## Panel wiring changes (`ConnectivityPanel.tsx`)

- Add expansion state: `const [expanded, setExpanded] = useState<Set<string>>(new Set())`
  keyed by `flow.id`, with a `toggle(id)` matching the ConfigMaps pattern.
- `FlowRow` takes `isOpen` + `onToggle`; pass `expandedContent={<ConnectivityDetail flow={flow} />}`.
- The service/pods chips remain click-to-navigate (unchanged); the chevron and a
  click on the row body (not the existing nav buttons) toggle expansion.
- Keep the existing context menu ("View service" / "View pods"); optionally add a
  "Details" / "Collapse" item mirroring ConfigMaps, but not required.

## Accessibility

The chevron already sets `aria-label`/`aria-expanded` in `ListRow`. Making
`isOpen` real means those attributes now reflect actual state and the expanded
region becomes reachable — no extra work needed beyond passing real state.

## Testing

- `connectivityDisplay.test.ts`: update `podNames` assertions to `pods`
  (name/ready/phase); add a case asserting a mix of ready and not-ready pods
  produces the right `FlowPod.ready` flags and `readyPods` count.
- Component test for `ConnectivityDetail` (optional, light): renders pod rows +
  the missing-service empty state.
- `pnpm --filter web typecheck` + `pnpm --filter web test` green.

## Out of scope

- Port-forward UI, View YAML, Ask Claude handoff (already deferred in the panel).
- Any mutation / write path.
- Filtering or grouping controls (the chevron is a per-row disclosure, not a
  filter).
