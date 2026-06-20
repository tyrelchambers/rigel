# Cluster Visualizations — Design

**Date:** 2026-06-01
**Status:** Approved (design); pending implementation plan
**App:** Rigel (macOS, SwiftUI, Kubernetes UI)

## Goal

Rigel already collects rich metrics (metrics-server snapshots, a 60-sample
rolling per-pod history in SQLite, optional Prometheus/VictoriaMetrics, full
event streams, right-sizing verdicts) but renders almost all of it as tables.
The only existing graphic is the custom Canvas sparkline in the Pods table; no
Swift Charts is used anywhere.

This initiative adds **four visualizations** on a shared foundation, turning the
collected-but-unused data into at-a-glance insight for a solo dev maintaining
their own cluster and self-hosted apps.

The four:

1. **Cluster topology map** — treemap of nodes → pods, sized by usage, colored by health.
2. **Right-sizing usage bands** — typical→peak shaded band vs request/limit lines over 24h.
3. **Overview cluster gauges + waste headline** — ring gauges (CPU/mem) + total reclaimable.
4. **Event timeline** — horizontal severity-colored event ribbon.

## Decisions (locked during brainstorming)

| Decision | Choice | Notes |
|---|---|---|
| Placement | **Into existing panels** | Topology is the one exception (new tab — no existing home) |
| Usage-band data source | **Prometheus-only, empty state otherwise** | No fallback to thin local data, per "never add a fallback without asking" |
| Topology render style | **Treemap (nested rectangles)** | Space-efficient, scales to many pods, readable |
| Charting framework | **Swift Charts** (native) | macOS deployment target is `.v14`; Charts needs 13+, so available |
| Structure | **One initiative, shared foundation, built in sequence** | Not four disconnected projects |

## Architecture

A new focused module holds reusable Swift Charts components plus a thin layer of
**pure aggregation/layout functions** that are testable without UI. Everything
reads from data already collected in `ClusterCache`; only the usage-band chart
(#2) adds a new query (a Prometheus range query).

```
Sources/Rigel/Charts/
  ChartTheme.swift        — shared colors/scales (health → color, etc.)
  RingGauge.swift         — cluster CPU/mem gauges                 (#3)
  UsageBandChart.swift    — typical→peak area + request/limit lines (#2)
  EventTimeline.swift     — horizontal event ribbon                 (#4)
  TreemapLayout.swift     — squarified treemap algorithm (pure)
  ClusterTreemap.swift    — treemap view over node→pod model        (#1)
  Aggregations.swift      — pure: cluster used/allocatable, Σreclaimable,
                            event time-bucketing, treemap model builder
```

Design principle: the logic (and tests) live in the pure functions
(`Aggregations.swift`, `TreemapLayout.swift`); the SwiftUI/Charts views stay
thin wrappers over those outputs.

## Features & wiring

### #3 — Overview gauges + waste headline
- Two `RingGauge`s: cluster CPU and memory, **used vs allocatable**, computed
  from existing node metrics-server snapshots.
- One headline: *"~X GB reclaimable across N workloads,"* summed from the
  right-sizing verdicts already computed.
- Reads `ClusterCache` only — no new network calls.
- Lives on the **Overview** panel.

### #4 — Event timeline
- `EventTimeline` ribbon buckets the cached ~500 events by time, severity-colored,
  so incident clusters are visible at a glance.
- Full version at the top of the **Events** panel; compact version on **Overview**.
- Reads cached events only.

### #1 — Cluster topology (treemap)
- New `PanelKind.topology` + `TopologyPanel`.
- Squarified treemap: nodes = boxes, pods = tiles sized by CPU/mem usage,
  colored by health/restarts.
- Pods missing usage data render at a minimum size, dimmed — a presentation
  default, **not** a data fallback.
- Reads pod→node assignment + usage snapshot from `ClusterCache`.
- Interaction: clicking a tile selects that pod.

### #2 — Right-sizing usage bands
- `UsageBandChart` in the **Right-Sizing** detail view: shaded typical→peak band
  vs request/limit horizontal rule lines, over 24h.
- Extends `PrometheusMetricsSource` with a **range query** per workload.
- **Renders only when a Prometheus/VictoriaMetrics source is configured.**
  Otherwise shows an honest empty state ("Connect Prometheus/VictoriaMetrics for
  historical usage bands"). No local fallback.

## Data flow

- #1, #3, #4 are reactive off `ClusterCache` snapshots — zero new fetching.
- #2 invokes Prometheus range queries lazily, only when a source is configured.

## Error / empty states (not fallbacks)

| Condition | Behavior |
|---|---|
| No metrics-server data | Gauges (#3) show "metrics unavailable" empty state |
| No Prometheus/VM source | Usage band (#2) shows empty state with connect hint |
| No events cached | Timeline (#4) shows empty state |
| Pod missing usage data | Treemap (#1) tile at min size, dimmed |

## Testing

Pure functions get unit tests (TDD, matching the existing test setup in
`Tests/RigelTests/`):
- squarified treemap layout (`TreemapLayout`)
- Σreclaimable math (`Aggregations`)
- gauge used/allocatable ratios (`Aggregations`)
- event time-bucketing (`Aggregations`)

Swift Charts views are kept thin enough not to require snapshot tests.

## Build sequence

1. **Foundation** — `Charts/` scaffold, `ChartTheme`, `Aggregations` (TDD).
2. **#3 Overview gauges + waste headline** — fastest visible win, snapshot data only.
3. **#4 Event timeline** — Events panel + Overview ribbon.
4. **#1 Topology treemap** — new tab, squarified layout.
5. **#2 Usage bands** — Prometheus range queries + empty state (most plumbing, last).

## Out of scope (future)

- Local-history fallback for usage bands (explicitly declined for v1).
- Packed-bubble / force-directed topology variants.
- CNPG database charts, pod health heatmap, node bin-packing bars (honorable
  mentions from brainstorming, not part of this initiative).
