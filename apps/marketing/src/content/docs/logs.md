---
title: "Logs — live tail, filter & scan"
description: "Live multi-pod log tail with filtering, scanning, and probe-noise suppression."
category: "Guides"
order: 2
icon: "lucide:scroll-text"
---

Tail logs live from any workload or pod, with all replicas merged into one chronological stream — and scan them fast with filtering, highlighting, an errors-only view, and log-level coloring. Pick a container, narrow the time window, isolate a single pod, or pull up a **crashed container's previous logs**. Copy or download what you see. It's a `kubectl logs` stream piped over the app's WebSocket; no log backend required.

**Where:** **Logs** (`/logs`). Pick a source in the left sidebar to open its stream.

---

## Choosing a source (sidebar)

The sidebar has a **kind selector** — **Deploy / STS / DS / Pods** — and a **search box** over the list (matches name or namespace; handy with dozens of workloads). Pick a **Deployment / StatefulSet / DaemonSet** to tail all its pods by label selector, or switch to **Pods** to tail a single pod by name. Each row shows `ready/total` (or the pod's phase), red when unhealthy.

## The stream

Selecting a source runs `kubectl logs -f --timestamps --prefix` for it and merges the output **chronologically across replicas**. Each line shows its source pod (color-coded), an `HH:MM:SS` timestamp, and the text. Up to 5,000 lines are retained; the list is **virtualized** (only the visible rows are in the DOM), so it stays smooth even on chatty streams. The view **auto-follows** the bottom; scroll up to pause following and a **Jump to latest** button appears. The stream process is killed when you close it, switch kinds, or leave the panel — no zombie `kubectl` processes.

A **stats readout** in the toolbar shows `shown / total lines`, an **error count**, a **buffer full** badge once the 5,000-line cap is reached, and a **paused · N dropped** count (pausing drops incoming lines rather than buffering them).

---

## Scan controls (toolbar)

* **Filter** — case-insensitive substring; matches are **highlighted** in-line with a `**K / N lines**` count. Toggle **Regex** (`.*`) for a pattern (an invalid pattern shows "invalid pattern" and matches nothing).
* **Errors only** — show only `error` / `fatal` / `panic` lines. **Hide probes** — drop kubelet/health-check noise.
* **Level coloring** — error red, warn amber.
* **Wrap lines** (⌥⌘W) — wrap instead of truncate; click (or focus + Enter/Space) a line to expand it.
* **Pause / Resume**, **Clear**, **Copy visible**, **Download** `**.log**`.
* **Collapsed pod column** — hidden when only one pod is in the stream (the per-line color bar still marks identity).

## Choosing what to tail

* **Pod isolation** — when a stream spans replicas, **pod chips** appear; click one to solo that pod (click again to clear). Client-side, instant.
* **Container picker** — for multi-container pods, filter the stream to one container (or *All containers*).
* **Tail size** — recent lines per pod: **200 / 500 / 1000**.
* **Since** — recent window: **All time / 5m / 1h**.
* **Previous (crashed) logs** — the **history** toggle pulls the **previous container instance's** logs — the way to see *why a CrashLoopBackOff died*. One-shot dump (not live), shown with a **"previous instance · not live"** banner; pause is disabled. In a multi-container pod the picked container is fetched with `-c`.

Pod isolation and the container picker filter in place (live); changing tail size, since, or previous re-issues the stream.

---

## Ask the Helmsman about a line

Hover a line for a **✨ Ask** button, or right-click for **Ask about this line** / **Copy line**. "Ask" hands the line plus ±5 surrounding lines (11 total) to the chat copilot with the source + namespace, so it can investigate in context.

---

## Notes & limitations

* Live tail only — this is `kubectl logs`, not a historical/full-text log store.
* **Pause drops** incoming lines rather than buffering them (the dropped count is surfaced in the stats readout).

---

## Operational

* Wire protocol over `/ws`: `{type:"logs.start", targets:[{namespace, labelSelector|pod, container?, previous?, since?}], tailLines}` → `{type:"logs", pod, container, line}` per line / `{type:"logs.error", message}`; `{type:"logs.stop"}` (ws close also kills the processes). Server arg-building in `apps/server/src/logStream.ts` (`buildLogsArgs`): `container` → `-c`, `previous` → `--previous` (one-shot, no `-f`), `since` → `--since`.
* Client: `apps/web/src/panels/logs/LogsPanel.tsx` (list virtualized with `@tanstack/react-virtual`); pure logic in `logDisplay.ts` (filter/highlight/level/container/pod/stats/export) + `logTargets.ts` (per-kind sidebar normalization) — both unit-tested. Shared parser/probe/error helpers in `packages/k8s/src/logs.ts`.
* Behind the same session auth as the rest of the app.
