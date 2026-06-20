# Logs overhaul — Phase 2 (Debugging power) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the debugging essentials to the Logs panel — a container picker for multi-container pods, **previous (crashed-container) logs**, and since / tail-size controls.

**Architecture:** The server's `buildLogsArgs` is extended (still pure, still tested) to honor `container` (`-c`), `previous` (`--previous`, dropping `-f`), and `since` (`--since`). `LogTarget` gains `previous`/`since` on both the server and the ws client (it already has `container`). The client surfaces the per-line `container` (already sent by the server) onto `LogLine`, filters by it client-side for live streams, and re-issues the stream for tail/since/previous changes. Spec: `docs/superpowers/specs/2026-06-18-logs-panel-overhaul-design.md` (Phase 2).

**Tech Stack:** Bun (server) + bun:test, React 19 + Vite + vitest (web), Tailwind v4, lucide-react. Shared parser in `packages/k8s/src/logs.ts`.

---

## File structure

- **Modify** `apps/server/src/logStream.ts` — `LogTarget` gains `previous?`/`since?`; `buildLogsArgs` honors `container`/`previous`/`since`.
- **Modify** `apps/server/src/logStream.test.ts` — new `buildLogsArgs` cases (container, previous, since); keep the existing default-order test green.
- **Modify** `apps/web/src/lib/ws.ts` — `LogTarget` gains `previous?`/`since?` (mirror the server).
- **Modify** `apps/web/src/panels/logs/logDisplay.ts` — `LogLine.container?`; `toLogLine(raw, container?)`; `distinctContainers`; `filterLines` gains an optional `container` filter.
- **Modify** `apps/web/src/panels/logs/logDisplay.test.ts` — tests for container plumb + `distinctContainers` + container filter.
- **Modify** `apps/web/src/panels/logs/LogsPanel.tsx` — container picker (client filter), tail/since controls, previous toggle + "not live" banner, stream re-issue.

**Verification:** bun + vitest for pure logic; `pnpm --filter web typecheck && build` + `pnpm --filter @rigel/server test`; then Playwright re-drive + `docker compose up -d --build`; Outline doc updated.

**Convention:** extend `filterLines`/`toLogLine` rather than forking (per the user's global rules). New helper `distinctContainers` mirrors the existing `distinctPods` exactly.

---

## Task 1: Server `buildLogsArgs` — container / previous / since (TDD)

**Files:**
- Modify: `apps/server/src/logStream.ts` (`LogTarget`, `buildLogsArgs`)
- Test: `apps/server/src/logStream.test.ts`

- [ ] **Step 1: Write the failing tests.** Append to `apps/server/src/logStream.test.ts`:

```ts
test("buildLogsArgs: container uses -c and omits --all-containers", () => {
  const t: LogTarget = { namespace: "default", labelSelector: "app=web", container: "app" };
  const args = buildLogsArgs(t, 200);
  expect(args).toContain("-c");
  expect(args[args.indexOf("-c") + 1]).toBe("app");
  expect(args).not.toContain("--all-containers=true");
});

test("buildLogsArgs: previous drops -f and adds --previous", () => {
  const t: LogTarget = { namespace: "default", labelSelector: "app=web", previous: true };
  const args = buildLogsArgs(t, 200);
  expect(args).not.toContain("-f");
  expect(args).toContain("--previous");
});

test("buildLogsArgs: since adds --since=<v>", () => {
  const t: LogTarget = { namespace: "default", pod: "web-0", since: "5m" };
  expect(buildLogsArgs(t, 100)).toContain("--since=5m");
});

test("buildLogsArgs: default (no container/previous/since) is unchanged", () => {
  const t: LogTarget = { namespace: "default", labelSelector: "app=web" };
  expect(buildLogsArgs(t, 200)).toEqual([
    "logs", "-f", "--timestamps", "--prefix=true", "--all-containers=true",
    "-n", "default", "-l", "app=web", "--max-log-requests=20", "--tail=200",
  ]);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @rigel/server test 2>&1 | tail -20`
Expected: FAIL — `previous`/`since` not on `LogTarget` (type error) and the container/previous/since assertions fail.

- [ ] **Step 3: Implement.** In `apps/server/src/logStream.ts`, extend the `LogTarget` interface to add two fields (after `container?: string;`):
```ts
  /** Fetch the previous (crashed) container instance; implies a one-shot (no -f). */
  previous?: boolean;
  /** kubectl --since window, e.g. "5m" or "1h". */
  since?: string;
```
Then replace `buildLogsArgs` with:
```ts
/**
 * Build the kubectl argv (without the `kubectl` binary / `--context`) for one
 * log target. Default mirrors the Swift tail command:
 *   logs -f --timestamps --prefix=true --all-containers=true -n <ns>
 *        (-l <selector> | <pod>) --max-log-requests=20 --tail=<n>
 * Extensions: `container` → `-c <c>` in place of `--all-containers`; `previous`
 * → `--previous` and DROP `-f` (a dead container can't be followed); `since` →
 * `--since=<v>`.
 */
export function buildLogsArgs(target: LogTarget, tailLines: number): string[] {
  const args = ["logs"];
  if (!target.previous) args.push("-f"); // --previous is a one-shot dump
  args.push("--timestamps", "--prefix=true");
  if (target.container) args.push("-c", target.container);
  else args.push("--all-containers=true");
  args.push("-n", target.namespace);
  if (target.labelSelector) {
    args.push("-l", target.labelSelector);
  } else if (target.pod) {
    args.push(target.pod);
  }
  if (target.previous) args.push("--previous");
  if (target.since) args.push(`--since=${target.since}`);
  args.push("--max-log-requests=20", `--tail=${tailLines}`);
  return args;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @rigel/server test 2>&1 | tail -6`
Expected: PASS (all server tests, including the unchanged-default case).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/logStream.ts apps/server/src/logStream.test.ts
git commit -m "feat(logs/server): buildLogsArgs honors container (-c), previous (--previous, no -f), since"
```

---

## Task 2: Client log model — container plumb + filter (TDD)

**Files:**
- Modify: `apps/web/src/lib/ws.ts` (`LogTarget` fields — mirror server)
- Modify: `apps/web/src/panels/logs/logDisplay.ts` (`LogLine.container`, `toLogLine`, `distinctContainers`, `filterLines`)
- Test: `apps/web/src/panels/logs/logDisplay.test.ts`

- [ ] **Step 1: Write the failing tests.** Add `distinctContainers` to the `./logDisplay` import in the test, then append:

```ts
describe("toLogLine container", () => {
  it("plumbs the container argument onto the line", () => {
    const l = toLogLine("[pod/web-0/app] 2026-06-09T17:15:42.000Z hi", "app");
    expect(l.container).toBe("app");
    expect(l.text).toBe("hi");
  });
  it("defaults container to empty string when omitted", () => {
    expect(toLogLine("plain line").container).toBe("");
  });
});

describe("distinctContainers", () => {
  it("unique containers in first-seen order, skipping empties", () => {
    const ls = [
      { id: "1", sourcePod: "p", timestamp: null, text: "a", colorIndex: 0, container: "app" },
      { id: "2", sourcePod: "p", timestamp: null, text: "b", colorIndex: 0, container: "sidecar" },
      { id: "3", sourcePod: "p", timestamp: null, text: "c", colorIndex: 0, container: "app" },
      { id: "4", sourcePod: "p", timestamp: null, text: "d", colorIndex: 0, container: "" },
    ];
    expect(distinctContainers(ls)).toEqual(["app", "sidecar"]);
  });
});

describe("filterLines container", () => {
  const ls = [
    { id: "1", sourcePod: "p", timestamp: null, text: "a", colorIndex: 0, container: "app" },
    { id: "2", sourcePod: "p", timestamp: null, text: "b", colorIndex: 0, container: "sidecar" },
  ];
  const base = { hideProbes: false, errorsOnly: false, query: buildLogQuery("", false) };
  it("keeps only the selected container when set", () => {
    expect(filterLines(ls, { ...base, container: "sidecar" }).map((l) => l.text)).toEqual(["b"]);
  });
  it("empty/undefined container keeps everything", () => {
    expect(filterLines(ls, base).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter web test logDisplay 2>&1 | tail -20`
Expected: FAIL — `container` not on `LogLine`, `toLogLine` takes one arg, `distinctContainers` missing, `filterLines` has no `container` option.

- [ ] **Step 3: Implement in `logDisplay.ts`.**

(a) Add `container?` to `LogLine` (after `colorIndex: number;`):
```ts
  /** Source container (from the server's per-line attribution). "" when unknown. */
  container?: string;
```
(b) Extend `toLogLine` to accept and set the container:
```ts
/** Build a LogLine (with id) from a raw kubectl `--prefix --timestamps` line.
 *  `container` is the server-attributed container for this line (may be ""). */
export function toLogLine(raw: string, container = ""): LogLine {
  const p = parseLogLine(raw);
  return {
    id: nextId(),
    sourcePod: p.sourcePod,
    timestamp: p.timestamp,
    text: p.text,
    colorIndex: p.colorIndex,
    container,
  };
}
```
(c) Add `container` to `FilterOptions` and the `filterLines` body. Change the interface:
```ts
export interface FilterOptions {
  hideProbes: boolean;
  errorsOnly: boolean;
  query: LogQuery;
  /** When non-empty, keep only lines from this container (live client-side filter). */
  container?: string;
}
```
and add this predicate inside `filterLines`'s `.filter` (before `return true;`):
```ts
    if (opts.container && l.container !== opts.container) return false;
```
(d) Add `distinctContainers` next to `distinctPods`:
```ts
/** Distinct non-empty `container` names across the lines, in first-seen order. */
export function distinctContainers(lines: LogLine[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const c = l.container ?? "";
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}
```

- [ ] **Step 4: Mirror the `LogTarget` fields on the client `ws.ts`.** In `apps/web/src/lib/ws.ts`, add to the `LogTarget` interface (after `container?: string;`):
```ts
  previous?: boolean;
  since?: string;
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter web test logDisplay && pnpm --filter web typecheck 2>&1 | tail -4`
Expected: PASS. (Existing `mkLine`-based tests still pass — `container` is optional on `LogLine`.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/ws.ts apps/web/src/panels/logs/logDisplay.ts apps/web/src/panels/logs/logDisplay.test.ts
git commit -m "feat(logs): plumb per-line container; distinctContainers + filterLines container filter; ws LogTarget previous/since"
```

---

## Task 3: Container picker (client-side filter) in the UI

**Files:**
- Modify: `apps/web/src/panels/logs/LogsPanel.tsx`

(No unit test — logic is covered by Task 2; verify via typecheck/build.)

- [ ] **Step 1: Surface the container on inbound lines.** In `LogsPanel.tsx`, find the `onLogLine` handler (the `useEffect` that calls `toLogLine(m.line)`). Change `toLogLine(m.line)` to `toLogLine(m.line, m.container)`.

- [ ] **Step 2: Add container state + reset on (re)select.** Add near the other `useState`s:
```tsx
  const [selectedContainer, setSelectedContainer] = useState("");
```
In `selectDeployment` (where it resets `setLines([])`, `setError(null)`, etc.), add:
```tsx
    setSelectedContainer("");
```

- [ ] **Step 3: Feed the container filter into the `filtered` memo.** Update the memo added in Phase 1:
```tsx
  const filtered = useMemo(
    () => sortByTimestamp(filterLines(lines, { hideProbes, errorsOnly, query, container: selectedContainer })),
    [lines, hideProbes, errorsOnly, query, selectedContainer],
  );
```
Add the imports `distinctContainers` to the `./logDisplay` import block, and compute the options (memoized) near `collapsePod`:
```tsx
  const containers = useMemo(() => distinctContainers(lines), [lines]);
```

- [ ] **Step 4: Render the container `<select>` in the toolbar.** In the toolbar row, after the errors-only toggle (or wherever fits visually), add a select that only appears once more than one container has been seen:
```tsx
              {containers.length > 1 && (
                <select
                  value={selectedContainer}
                  onChange={(e) => setSelectedContainer(e.target.value)}
                  aria-label="Filter by container"
                  className="rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                  style={{ height: 28 }}
                >
                  <option value="">All containers</option>
                  {containers.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              )}
```

- [ ] **Step 5: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/logs/LogsPanel.tsx
git commit -m "feat(logs): container picker — client-side filter for multi-container pods"
```

---

## Task 4: Tail size, since window, and previous-logs mode

**Files:**
- Modify: `apps/web/src/panels/logs/LogsPanel.tsx`

(No unit test — verified via typecheck/build + the Task 5 Playwright drive. Server arg-building is covered by Task 1.)

- [ ] **Step 1: Add stream-option state.** Add near the other `useState`s:
```tsx
  const [tailLines, setTailLines] = useState(200);
  const [since, setSince] = useState("");      // "" | "5m" | "1h"
  const [previous, setPrevious] = useState(false);
```

- [ ] **Step 2: Extract a `startStream` helper and use it from `selectDeployment`.** Replace the body of `selectDeployment` that builds and sends the target. Currently it ends with:
```tsx
    const selector = labelSelector(d);
    if (!selector) {
      setError("deployment has no spec.selector.matchLabels");
      return;
    }
    sendLogsStart([{ namespace: d.metadata.namespace ?? "default", labelSelector: selector }], 200);
```
Replace the `sendLogsStart(...)` line with a call to a new `startStream(d, { previous, since, tailLines })` helper. Add this `useCallback` (above `selectDeployment`, since `selectDeployment` will call it):
```tsx
  // (Re)issue the kubectl-logs stream for a deployment with the current options.
  // `previous` is a one-shot (no -f) dump of the crashed container; in that mode
  // the selected container (if any) is passed to the server as -c.
  const startStream = useCallback(
    (d: Deployment, o: { previous: boolean; since: string; tailLines: number; container: string }) => {
      const selector = labelSelector(d);
      if (!selector) {
        setError("deployment has no spec.selector.matchLabels");
        return;
      }
      sendLogsStop();
      setLines([]);
      setExpandedLines(new Set());
      setError(null);
      setStickToBottom(true);
      sendLogsStart(
        [{
          namespace: d.metadata.namespace ?? "default",
          labelSelector: selector,
          previous: o.previous,
          since: o.since || undefined,
          container: o.previous && o.container ? o.container : undefined,
        }],
        o.tailLines,
      );
    },
    [],
  );
```
Then simplify `selectDeployment` to set selection state + reset options + call `startStream`:
```tsx
  const selectDeployment = useCallback((d: Deployment) => {
    const key = deploymentKey(d);
    setSelectedKey(key);
    setSelectedContainer("");
    setPrevious(false);
    startStream(d, { previous: false, since, tailLines, container: "" });
  }, [startStream, since, tailLines]);
```
(`startStream` already does the `sendLogsStop`/`setLines([])`/reset; keep `selectDeployment` from duplicating those.)

- [ ] **Step 3: Re-issue when tail/since/previous change.** Add a handler that re-runs the stream against the currently `selected` deployment with new options, and wire it to the controls. Add:
```tsx
  function reissue(next: { tailLines?: number; since?: string; previous?: boolean }) {
    const t = next.tailLines ?? tailLines;
    const s = next.since ?? since;
    const p = next.previous ?? previous;
    if (next.tailLines !== undefined) setTailLines(next.tailLines);
    if (next.since !== undefined) setSince(next.since);
    if (next.previous !== undefined) setPrevious(next.previous);
    if (selected) startStream(selected, { previous: p, since: s, tailLines: t, container: selectedContainer });
  }
```

- [ ] **Step 4: Render the tail/since selects + previous toggle in the toolbar.** Add to the toolbar:
```tsx
              <select
                value={tailLines}
                onChange={(e) => reissue({ tailLines: Number(e.target.value) })}
                aria-label="Tail size"
                className="rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                style={{ height: 28 }}
              >
                <option value={200}>200</option>
                <option value={500}>500</option>
                <option value={1000}>1000</option>
              </select>
              <select
                value={since}
                onChange={(e) => reissue({ since: e.target.value })}
                aria-label="Since"
                className="rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                style={{ height: 28 }}
              >
                <option value="">All time</option>
                <option value="5m">5m</option>
                <option value="1h">1h</option>
              </select>
              <Button
                variant={previous ? "secondary" : "ghost"}
                size="icon-sm"
                aria-label="Previous (crashed) container logs"
                aria-pressed={previous}
                title="Show the previous (crashed) container instance"
                onClick={() => reissue({ previous: !previous })}
              >
                <History />
              </Button>
```
Add `History` to the `lucide-react` import.

- [ ] **Step 5: Show a "previous instance · not live" banner.** Just above the log scroll area (near the existing `error &&` banner), add:
```tsx
            {previous && (
              <div className="border-b bg-amber-500/10 px-3 py-1.5 font-mono text-[11px] text-amber-700 dark:text-amber-400" role="status">
                previous instance · not live — showing the crashed container's last logs
              </div>
            )}
```
Also, while in previous mode, disable the Pause button (following is meaningless on a one-shot). Set `disabled={previous}` on the existing Pause `<Button>`.

- [ ] **Step 6: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/panels/logs/LogsPanel.tsx
git commit -m "feat(logs): tail size + since controls and previous (crashed) container logs mode"
```

---

## Task 5: Verify live + Docker rebuild + docs

**Files:** none (verification only)

- [ ] **Step 1: Full server + web tests + typecheck**

Run: `pnpm --filter @rigel/server test && pnpm --filter web typecheck && pnpm --filter web test 2>&1 | grep -E "pass|Test Files|Tests "`
Expected: all PASS.

- [ ] **Step 2: Rebuild the container**

Run: `docker compose up -d --build`
Expected: `rigel-web` rebuilt on :8787.

- [ ] **Step 3: Playwright re-drive.** Open `/logs`, pick a deployment, and confirm: the tail-size + since selects and the previous (History) toggle are present; selecting a multi-container deployment shows the container `<select>`; toggling previous shows the amber "not live" banner and disables Pause. Screenshot to `/tmp/logs-analyze/p2-*.png`. (Do not assert on a specific crashed pod existing — just confirm the controls render and the banner appears on toggle.)

- [ ] **Step 4: Update the Outline doc.** Edit the "Logs — live tail, filter & scan" doc (Rigel collection `f9bbcd7a-173c-4827-a709-f86082933031`, doc id `70a019c7-a6a9-42ed-b101-87ab50ec6df7`): move container picker / previous-logs / since+tail out of "planned" into the live feature list.

---

## Self-review notes (addressed)

- **Spec coverage (Phase 2):** container picker (Tasks 2,3 — client-side filter; Task 1/4 — server `-c` for previous), previous logs (Tasks 1,4 — `--previous` no `-f` + banner + Pause disabled), since/tail (Tasks 1,4) — all covered.
- **Type consistency:** `LogTarget` gains `previous?`/`since?` identically on server (`logStream.ts`, Task 1) and client (`ws.ts`, Task 2). `LogLine.container?`, `FilterOptions.container?`, `toLogLine(raw, container?)`, `distinctContainers` names are used identically across `logDisplay.ts`, its tests, and `LogsPanel.tsx`.
- **Default-behavior safety:** `buildLogsArgs` keeps the exact existing arg order when no new field is set (asserted by the Task 1 "default unchanged" test); all new `LogTarget` fields are optional.
- **Refactor-not-duplicate:** `filterLines`/`toLogLine` are extended; `distinctContainers` mirrors `distinctPods` (distinct purpose: containers vs pods).
- **Previous mode UX:** one-shot (server drops `-f`), banner shown, Pause disabled; a missing previous-container surfaces via the existing `logs.error` banner.
