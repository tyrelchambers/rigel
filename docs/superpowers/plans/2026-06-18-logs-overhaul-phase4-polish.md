# Logs overhaul — Phase 4 (Smoothness & polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Logs panel smooth and complete — virtualize the line list, add download / copy-all, surface line/error/buffer/dropped stats, and fix the row accessibility.

**Architecture:** Pure stats + export helpers go in `logDisplay.ts` (tested). The list is virtualized with `@tanstack/react-virtual` (dynamic row measurement, sticky-bottom preserved) so DOM size stays bounded regardless of the 5,000-line buffer. The error banner becomes a live region; log rows become keyboard-operable. Spec: `docs/superpowers/specs/2026-06-18-logs-panel-overhaul-design.md` (Phase 4).

**Tech Stack:** React 19, Vite, Tailwind v4, `@tanstack/react-virtual` (new), lucide-react, vitest.

---

## File structure

- **Modify** `apps/web/package.json` — add `@tanstack/react-virtual`.
- **Modify** `apps/web/src/panels/logs/logDisplay.ts` — `streamStats`, `buildLogText` (pure).
- **Modify** `apps/web/src/panels/logs/logDisplay.test.ts` — tests for both.
- **Modify** `apps/web/src/panels/logs/LogsPanel.tsx` — a11y rows + live banner; download/copy-all + stats; virtualize the list.

**Verification:** vitest for pure logic; `pnpm --filter web typecheck && build`; then a Playwright re-drive that checks the DOM stays small under a long stream (virtualization) + sticky-bottom; Docker rebuild; Outline doc.

---

## Task 1: deps + stats/export helpers (TDD)

**Files:**
- Modify: `apps/web/package.json` (dependency)
- Modify: `apps/web/src/panels/logs/logDisplay.ts`
- Test: `apps/web/src/panels/logs/logDisplay.test.ts`

- [ ] **Step 1: Add the virtualizer dependency.**

Run: `pnpm --filter web add @tanstack/react-virtual`
Expected: latest 3.x added to `apps/web/package.json` + lockfile updated.

- [ ] **Step 2: Write the failing tests.** Add `streamStats`, `buildLogText` to the `./logDisplay` import in the test, then append:
```ts
describe("streamStats", () => {
  it("counts total and error lines", () => {
    const ls = [
      { id: "1", sourcePod: "p", timestamp: null, text: "ok", colorIndex: 0 },
      { id: "2", sourcePod: "p", timestamp: null, text: "ERROR boom", colorIndex: 0 },
      { id: "3", sourcePod: "p", timestamp: null, text: "panic!", colorIndex: 0 },
    ];
    expect(streamStats(ls)).toEqual({ total: 3, errors: 2 });
  });
  it("empty → zeros", () => {
    expect(streamStats([])).toEqual({ total: 0, errors: 0 });
  });
});

describe("buildLogText", () => {
  it("joins pod, HH:MM:SS, and text per line", () => {
    const ts = new Date("2026-06-09T17:15:42.000Z");
    const ls = [
      { id: "1", sourcePod: "web-0", timestamp: ts, text: "hello", colorIndex: 0 },
      { id: "2", sourcePod: "web-1", timestamp: null, text: "world", colorIndex: 0 },
    ];
    const out = buildLogText(ls).split("\n");
    expect(out[0]).toBe(`web-0 ${formatTimestamp(ts)} hello`);
    expect(out[1]).toBe("web-1 world");
  });
});
```
(`formatTimestamp` is already imported in the test file.)

- [ ] **Step 3: Run to verify fail**

Run: `pnpm --filter web test logDisplay 2>&1 | tail -15`
Expected: FAIL — `streamStats`/`buildLogText` not functions.

- [ ] **Step 4: Implement** in `logDisplay.ts` (near the other pure helpers):
```ts
/** Aggregate counts for the stats readout. */
export function streamStats(lines: LogLine[]): { total: number; errors: number } {
  let errors = 0;
  for (const l of lines) if (isErrorLine(l.text)) errors++;
  return { total: lines.length, errors };
}

/** Render lines as plain text ("pod HH:MM:SS text" per line) for copy/download. */
export function buildLogText(lines: LogLine[]): string {
  return lines
    .map((l) => [l.sourcePod, formatTimestamp(l.timestamp), l.text].filter(Boolean).join(" "))
    .join("\n");
}
```
(`isErrorLine` and `formatTimestamp` are already in this module.)

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter web test logDisplay 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/panels/logs/logDisplay.ts apps/web/src/panels/logs/logDisplay.test.ts
git commit -m "feat(logs): add @tanstack/react-virtual; streamStats + buildLogText helpers"
```

---

## Task 2: Row accessibility + live error banner (UI)

**Files:**
- Modify: `apps/web/src/panels/logs/LogsPanel.tsx`

(No unit test — verify typecheck/build. READ the file first.)

- [ ] **Step 1: Make log rows keyboard-operable.** The row `<div onClick={() => toggleExpand(l.id)} … className="group … cursor-default …">` is a div with a click handler and no keyboard path. Change it to a focusable button-role element: add `role="button"`, `tabIndex={0}`, an `onKeyDown` that toggles on Enter/Space, an `aria-expanded`, and drop `cursor-default` (use `cursor-pointer`). Replace the row's opening tag attributes:
```tsx
                      role="button"
                      tabIndex={0}
                      aria-expanded={expanded}
                      onClick={() => toggleExpand(l.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(l.id); }
                      }}
                      onContextMenu={() => { ctxLineRef.current = l; }}
                      className="group flex min-h-[18px] cursor-pointer items-start gap-2 border-l-2 px-2 py-0.5 hover:bg-muted/50 focus:bg-muted/60 focus:outline-none"
```
(Keep the existing `key`, `style={{ borderLeftColor: color }}` on the row.)

- [ ] **Step 2: Make the error banner a polite live region.** On the `error &&` `<pre …>` banner, add `role="alert"` and `aria-live="assertive"` (errors are important; assertive is appropriate for a failure):
```tsx
              <pre role="alert" aria-live="assertive" className="border-b bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive whitespace-pre-wrap break-all">
                {error}
              </pre>
```

- [ ] **Step 3: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/panels/logs/LogsPanel.tsx
git commit -m "a11y(logs): keyboard-operable log rows + live error banner"
```

---

## Task 3: Download / copy-all + stats readout (UI)

**Files:**
- Modify: `apps/web/src/panels/logs/LogsPanel.tsx`

- [ ] **Step 1: Imports + dropped-while-paused counter.** Add `Download` and `Copy` to the `lucide-react` import, and `streamStats`, `buildLogText`, `MAX_LINES` to the `./logDisplay` import. Add state:
```tsx
  const [droppedWhilePaused, setDroppedWhilePaused] = useState(0);
```
In the `onLogLine` handler, when a line is dropped because paused, count it. Find `if (isPausedRef.current) return;` and change it to:
```tsx
      if (isPausedRef.current) { setDroppedWhilePaused((d) => d + 1); return; }
```
Reset the counter to 0 when resuming and when clearing: in the Pause/Resume button's onClick, when turning pause OFF reset it; and in `clear` add `setDroppedWhilePaused(0)`. The simplest: reset whenever `isPaused` goes false — change the Pause button onClick to:
```tsx
                onClick={() => setIsPaused((p) => { if (p) setDroppedWhilePaused(0); return !p; })}
```
and in the `clear` callback add `setDroppedWhilePaused(0);`. Also reset in `startStream` (add `setDroppedWhilePaused(0);` alongside `setLines([])`).

- [ ] **Step 2: Stats memo.**
```tsx
  const stats = useMemo(() => streamStats(lines), [lines]);
```

- [ ] **Step 3: Download + copy handlers.**
```tsx
  const copyAll = useCallback(() => {
    void navigator.clipboard.writeText(buildLogText(filtered));
  }, [filtered]);

  const downloadAll = useCallback(() => {
    const name = selectedItem ? `${selectedItem.namespace}-${selectedItem.name}` : "logs";
    const blob = new Blob([buildLogText(filtered)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered, selectedItem]);
```

- [ ] **Step 4: Render copy/download buttons + stats in the toolbar.** Add the buttons near Clear:
```tsx
              <Button variant="ghost" size="icon-sm" aria-label="Copy visible logs" title="Copy visible logs" onClick={copyAll}>
                <Copy />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Download logs" title="Download .log" onClick={downloadAll}>
                <Download />
              </Button>
```
And extend the count area (the existing `{filtered.length} / {lines.length} lines` span) so it also shows errors, a buffer-full pill, and dropped count. Replace that count span with:
```tsx
                <span className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-muted-foreground">
                  <span>{filtered.length.toLocaleString()} / {stats.total.toLocaleString()} lines</span>
                  {stats.errors > 0 && <span className="text-red-600 dark:text-red-400">{stats.errors.toLocaleString()} err</span>}
                  {stats.total >= MAX_LINES && <span className="rounded bg-amber-500/15 px-1 text-amber-700 dark:text-amber-400">buffer full</span>}
                  {droppedWhilePaused > 0 && <span className="text-amber-700 dark:text-amber-400">paused · {droppedWhilePaused.toLocaleString()} dropped</span>}
                </span>
```

- [ ] **Step 5: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/logs/LogsPanel.tsx
git commit -m "feat(logs): download / copy-all + error/buffer/dropped stats readout"
```

---

## Task 4: Virtualize the log list

**Files:**
- Modify: `apps/web/src/panels/logs/LogsPanel.tsx`

(The riskiest task — verify carefully via Playwright in Task 5. READ the current row-rendering block first.)

- [ ] **Step 1: Import the virtualizer.**
```tsx
import { useVirtualizer } from "@tanstack/react-virtual";
```

- [ ] **Step 2: Create the virtualizer** (after the `filtered` memo, with `scrollRef` already defined):
```tsx
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    overscan: 24,
    getItemKey: (i) => filtered[i].id,
  });
```

- [ ] **Step 3: Replace the auto-follow effect** (currently sets `scrollRef.current.scrollTop = scrollRef.current.scrollHeight`) with a virtualizer scroll:
```tsx
  useLayoutEffect(() => {
    if (stickRef.current && filtered.length > 0) {
      rowVirtualizer.scrollToIndex(filtered.length - 1, { align: "end" });
    }
  }, [filtered, rowVirtualizer]);
```

- [ ] **Step 4: Update `jumpToLatest`** to use the virtualizer:
```tsx
  const jumpToLatest = useCallback(() => {
    setStickToBottom(true);
    if (filtered.length > 0) rowVirtualizer.scrollToIndex(filtered.length - 1, { align: "end" });
  }, [filtered.length, rowVirtualizer]);
```

- [ ] **Step 5: Render virtual rows.** Replace the `filtered.map((l) => …)` block (inside `<ContextMenuTrigger>`) with a sized spacer + only the virtual items. The structure becomes:
```tsx
                  <ContextMenuTrigger>
                    <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
                      {rowVirtualizer.getVirtualItems().map((vi) => {
                        const l = filtered[vi.index];
                        const expanded = expandedLines.has(l.id);
                        const color = podColor(l.sourcePod);
                        const level = detectLevel(l.text);
                        const levelClass =
                          level === "error" ? "text-red-600 dark:text-red-400"
                          : level === "warn" ? "text-amber-600 dark:text-amber-400"
                          : "";
                        const segments = splitHighlight(l.text, query.ranges(l.text));
                        return (
                          <div
                            key={vi.key}
                            data-index={vi.index}
                            ref={rowVirtualizer.measureElement}
                            role="button"
                            tabIndex={0}
                            aria-expanded={expanded}
                            onClick={() => toggleExpand(l.id)}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(l.id); } }}
                            onContextMenu={() => { ctxLineRef.current = l; }}
                            className="group flex min-h-[18px] cursor-pointer items-start gap-2 border-l-2 px-2 py-0.5 hover:bg-muted/50 focus:bg-muted/60 focus:outline-none"
                            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)`, borderLeftColor: color }}
                          >
                            {!collapsePod && (
                              <span className="w-[150px] shrink-0 truncate" style={{ color }} title={l.sourcePod}>{l.sourcePod}</span>
                            )}
                            <span className="w-[80px] shrink-0 text-muted-foreground">{formatTimestamp(l.timestamp)}</span>
                            <span className={`flex-1 ${wrapLines || expanded ? "whitespace-pre-wrap break-all" : "truncate"} ${levelClass}`}>
                              {segments.map((seg, i) =>
                                seg.mark ? (
                                  <mark key={i} className="rounded-sm bg-yellow-300/70 text-black dark:bg-yellow-400/80">{seg.text}</mark>
                                ) : (
                                  <span key={i}>{seg.text}</span>
                                ),
                              )}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); askClaude(l); }}
                              aria-label="Ask Claude about this line"
                              title="Ask Claude about this line"
                              className="shrink-0 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                            >
                              <Sparkles className="size-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </ContextMenuTrigger>
```
This preserves every per-row feature (collapse pod column, timestamp, level color, highlight `<mark>`s, expand, Ask-Claude, context menu) — only the wrapping/positioning changed (absolute + transform inside a total-size spacer; `measureElement` handles variable heights from wrap/expand). Keep the surrounding `<ContextMenu>`/`<ContextMenuContent>` and the empty/"Waiting…" states unchanged. Keep `onScroll={onScroll}` and `style={{ overflowAnchor: "none" }}` on the scroll container.

- [ ] **Step 6: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/panels/logs/LogsPanel.tsx
git commit -m "perf(logs): virtualize the line list (@tanstack/react-virtual, dynamic measure, sticky bottom)"
```

---

## Task 5: Verify live + Docker + docs + merge

**Files:** none.

- [ ] **Step 1: Full tests + typecheck.** `pnpm --filter web typecheck && pnpm --filter web test 2>&1 | grep -E "Test Files|Tests "` — all PASS.
- [ ] **Step 2: Docker rebuild.** `docker compose up -d --build`.
- [ ] **Step 3: Playwright re-drive** (`/tmp/logs-analyze/p4probe.mjs`): open `/logs`, pick a chatty deployment, let it stream a few seconds, then assert: (a) the scroller's rendered row count is SMALL (virtualization — e.g. `< 120` row divs even though the buffer has hundreds), (b) the view is stuck to the bottom (the last visible line is near the latest), (c) the stats readout shows `lines` (+ `err` if any), (d) the copy/download buttons are present, (e) scrolling up reveals the "Jump to latest" button and clicking it returns to the bottom. Screenshot `/tmp/logs-analyze/p4-*.png`.
- [ ] **Step 4: Outline doc.** Edit the "Logs — live tail, filter & scan" doc (id `70a019c7-a6a9-42ed-b101-87ab50ec6df7`): move virtualization / download-copy / stats out of "planned (phase 4)" into live features; note the list is now virtualized (smooth at the 5,000-line cap).
- [ ] **Step 5: Merge + push.** `git checkout master && git fetch && git merge origin/master --no-edit && git merge --no-ff feature/logs-overhaul-phase4-polish -m "…" && git push origin master`.

---

## Self-review notes (addressed)

- **Spec coverage (Phase 4):** virtualization (Task 4), download/copy-all (Task 3), stats + buffer-full + dropped-while-paused (Task 3), a11y (keyboard rows + live banner, Task 2). All covered.
- **Type consistency:** `streamStats` → `{total, errors}`, `buildLogText` → string, used identically in helper + tests + `LogsPanel`. `rowVirtualizer` API (`getTotalSize`/`getVirtualItems`/`scrollToIndex`/`measureElement`) used consistently. `droppedWhilePaused`/`stats` wired in toolbar.
- **Virtualization correctness:** dynamic `measureElement` handles variable row heights (wrap/expand); sticky-bottom preserved via `scrollToIndex(last, {align:'end'})` in a layout effect; `onScroll` unstick logic unchanged (reads the same scroll element). All per-row features preserved (collapse/level/highlight/expand/ask/context-menu).
- **Reuse:** `streamStats`/`buildLogText` reuse `isErrorLine`/`formatTimestamp`; the row JSX is moved, not duplicated.
