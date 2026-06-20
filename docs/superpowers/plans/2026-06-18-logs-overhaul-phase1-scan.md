# Logs overhaul — Phase 1 (Faster to scan) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Logs panel faster to scan — errors-only filter, match highlighting + count, regex filter (with invalid-pattern handling), log-level coloring, and a collapsing pod column for single-replica streams.

**Architecture:** All new logic is pure functions added to `apps/web/src/panels/logs/logDisplay.ts` (unit-tested with vitest); the existing `filterLines` is refactored to an options bag so probe/errors/query filters compose. `LogsPanel.tsx` wires the new toolbar controls + row rendering. Client-only — no server/protocol changes. Spec: `docs/superpowers/specs/2026-06-18-logs-panel-overhaul-design.md` (Phase 1).

**Tech Stack:** React 19, Vite, Tailwind v4, lucide-react icons, vitest. Shared log helpers (`isProbeLine`/`isErrorLine`/`parseLogLine`) live in `packages/k8s/src/logs.ts` and are re-exported by `logDisplay.ts`.

---

## File structure

- **Modify** `apps/web/src/panels/logs/logDisplay.ts` — add `buildLogQuery`, refactor `filterLines` to an options bag, add `detectLevel`, `splitHighlight`, `distinctPods`.
- **Modify** `apps/web/src/panels/logs/logDisplay.test.ts` — migrate the 4 `filterLines` tests; add tests for the new helpers.
- **Modify** `apps/web/src/panels/logs/LogsPanel.tsx` — errors-only + regex toggles, invalid-pattern hint, `K / N` count, highlighted + level-colored rows, collapsed pod column.

**Note on conventions (from the user's global rules):** prefer extending an existing function over adding a near-duplicate — `filterLines` is refactored to take a filters object rather than adding a second filter function. New helpers (`buildLogQuery`, `detectLevel`, `splitHighlight`, `distinctPods`) each have a distinct purpose, not overlapping `filterLines`.

**Verification:** vitest for pure logic; `pnpm --filter web typecheck && build` for the UI; then a Playwright re-drive + `docker compose up -d --build`. (vitest here runs pure-logic tests only — `logDisplay.test.ts` imports `logDisplay.ts`, never the `.tsx`.)

---

## Task 1: `buildLogQuery` — unified matcher for filter + highlight (TDD)

**Files:**
- Modify: `apps/web/src/panels/logs/logDisplay.ts`
- Test: `apps/web/src/panels/logs/logDisplay.test.ts`

- [ ] **Step 1: Write the failing tests.** Add to `logDisplay.test.ts` — first extend the import list at the top (the existing block `import { toLogLine, … } from "./logDisplay";`) to also import `buildLogQuery`, then append:

```ts
describe("buildLogQuery", () => {
  it("empty query matches everything with no ranges", () => {
    const q = buildLogQuery("", false);
    expect(q.error).toBeNull();
    expect(q.test("anything")).toBe(true);
    expect(q.ranges("anything")).toEqual([]);
  });
  it("substring is case-insensitive and returns match ranges", () => {
    const q = buildLogQuery("err", false);
    expect(q.test("ERROR here")).toBe(true);
    expect(q.test("clean")).toBe(false);
    expect(q.ranges("ERROR err")).toEqual([[0, 3], [6, 9]]);
  });
  it("regex mode matches and ranges the pattern", () => {
    const q = buildLogQuery("e\\d+", true);
    expect(q.error).toBeNull();
    expect(q.test("code e42 ok")).toBe(true);
    expect(q.ranges("e1 e22")).toEqual([[0, 2], [3, 6]]);
  });
  it("invalid regex sets error and matches nothing", () => {
    const q = buildLogQuery("(", true);
    expect(q.error).not.toBeNull();
    expect(q.test("(")).toBe(false);
    expect(q.ranges("(")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web test logDisplay 2>&1 | tail -20`
Expected: FAIL — `buildLogQuery is not exported` / not a function.

- [ ] **Step 3: Implement.** In `logDisplay.ts`, add after the `LogLine` interface block (anywhere among the exports; put it just below `toLogLine`):

```ts
/**
 * A compiled filter query, built once per filter change and reused for both
 * line filtering (`test`) and highlight rendering (`ranges`). Empty query
 * matches everything with no highlights. In regex mode an invalid pattern sets
 * `error` and matches nothing (no silent fallback to substring).
 */
export interface LogQuery {
  /** Regex compile error message, or null. */
  error: string | null;
  /** Whether a line's text matches the query. */
  test: (text: string) => boolean;
  /** Highlight ranges `[start, end)` for matches in text ([] when none). */
  ranges: (text: string) => Array<[number, number]>;
}

/** Build a LogQuery from the raw filter text and the regex toggle. */
export function buildLogQuery(query: string, useRegex: boolean): LogQuery {
  if (query === "") {
    return { error: null, test: () => true, ranges: () => [] };
  }
  if (useRegex) {
    let re: RegExp;
    try {
      re = new RegExp(query, "gi");
    } catch (e) {
      return { error: e instanceof Error ? e.message : "invalid pattern", test: () => false, ranges: () => [] };
    }
    return {
      error: null,
      test: (text) => { re.lastIndex = 0; return re.test(text); },
      ranges: (text) => {
        const out: Array<[number, number]> = [];
        for (const m of text.matchAll(re)) {
          const start = m.index ?? 0;
          if (m[0].length > 0) out.push([start, start + m[0].length]);
        }
        return out;
      },
    };
  }
  const needle = query.toLowerCase();
  return {
    error: null,
    test: (text) => text.toLowerCase().includes(needle),
    ranges: (text) => {
      const out: Array<[number, number]> = [];
      const hay = text.toLowerCase();
      let i = hay.indexOf(needle);
      while (i >= 0) {
        out.push([i, i + needle.length]);
        i = hay.indexOf(needle, i + needle.length);
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web test logDisplay 2>&1 | tail -12`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/logs/logDisplay.ts apps/web/src/panels/logs/logDisplay.test.ts
git commit -m "feat(logs): buildLogQuery — unified substring/regex matcher + highlight ranges"
```

---

## Task 2: Refactor `filterLines` to a filters options bag (TDD)

**Files:**
- Modify: `apps/web/src/panels/logs/logDisplay.ts` (`filterLines`)
- Modify: `apps/web/src/panels/logs/logDisplay.test.ts` (migrate 4 tests + add errors-only)
- Modify: `apps/web/src/panels/logs/LogsPanel.tsx` (the one caller, ~line 118)

- [ ] **Step 1: Migrate + extend the tests.** In `logDisplay.test.ts`, replace the entire `describe("filterLines", () => { … })` block (currently 4 `it`s using `filterLines(lines, "", true)` etc.) with:

```ts
describe("filterLines", () => {
  const lines = [
    mkLine("GET /healthz HTTP/1.1"),
    mkLine("processing user request"),
    mkLine("User-Agent: kube-probe/1.28"),
    mkLine("ERROR something broke"),
  ];
  const opts = (over: Partial<{ hideProbes: boolean; errorsOnly: boolean; query: string; regex: boolean }> = {}) => ({
    hideProbes: over.hideProbes ?? false,
    errorsOnly: over.errorsOnly ?? false,
    query: buildLogQuery(over.query ?? "", over.regex ?? false),
  });
  it("hides probe noise when hideProbes is on", () => {
    const out = filterLines(lines, opts({ hideProbes: true })).map((l) => l.text);
    expect(out).toEqual(["processing user request", "ERROR something broke"]);
  });
  it("case-insensitive substring filter", () => {
    const out = filterLines(lines, opts({ query: "error" })).map((l) => l.text);
    expect(out).toEqual(["ERROR something broke"]);
  });
  it("applies hideProbes + query together", () => {
    const out = filterLines(lines, opts({ hideProbes: true, query: "request" })).map((l) => l.text);
    expect(out).toEqual(["processing user request"]);
  });
  it("empty filter + everything off returns everything", () => {
    expect(filterLines(lines, opts()).length).toBe(4);
  });
  it("errorsOnly keeps only error/fatal/panic lines", () => {
    const out = filterLines(lines, opts({ errorsOnly: true })).map((l) => l.text);
    expect(out).toEqual(["ERROR something broke"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web test logDisplay 2>&1 | tail -20`
Expected: FAIL — `filterLines` still has the old `(lines, filter, hideProbes)` signature; the object-arg calls don't type/behave correctly.

- [ ] **Step 3: Refactor `filterLines`.** In `logDisplay.ts`, replace the existing `filterLines` function (and its doc comment) with:

```ts
/** Filters applied to the live line buffer before rendering. */
export interface FilterOptions {
  /** Hide kubelet/health-probe noise. */
  hideProbes: boolean;
  /** Keep only error/fatal/panic lines. */
  errorsOnly: boolean;
  /** Compiled text query (substring or regex). Empty query keeps everything. */
  query: LogQuery;
}

/**
 * Apply the probe, errors-only, and text-query filters (all independent and
 * order-irrelevant). Mirrors the Swift `filteredLines` computed property,
 * extended with errors-only + regex. Build `query` once with `buildLogQuery`.
 */
export function filterLines(lines: LogLine[], opts: FilterOptions): LogLine[] {
  return lines.filter((l) => {
    if (opts.hideProbes && isProbeLine(l.text)) return false;
    if (opts.errorsOnly && !isErrorLine(l.text)) return false;
    if (!opts.query.test(l.text)) return false;
    return true;
  });
}
```

(`isProbeLine` and `isErrorLine` are already imported at the top of `logDisplay.ts`.)

- [ ] **Step 4: Update the caller in `LogsPanel.tsx`.** Find the `filtered` memo (currently `sortByTimestamp(filterLines(lines, filter, hideProbes))`, ~line 118) and replace it with a query memo + the new call. Replace:

```tsx
  const filtered = useMemo(
    () => sortByTimestamp(filterLines(lines, filter, hideProbes)),
    [lines, filter, hideProbes],
  );
```
with:
```tsx
  const query = useMemo(() => buildLogQuery(filter, useRegex), [filter, useRegex]);
  const filtered = useMemo(
    () => sortByTimestamp(filterLines(lines, { hideProbes, errorsOnly, query })),
    [lines, hideProbes, errorsOnly, query],
  );
```
Add `useRegex`/`errorsOnly` state near the other `useState` calls (with the existing ones around line 53-59):
```tsx
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
```
And add `buildLogQuery` to the `logDisplay` import block at the top of `LogsPanel.tsx` (only `buildLogQuery` here — `detectLevel`/`splitHighlight`/`distinctPods` are imported in Task 5, where they're first used, so every commit typechecks). Insert `buildLogQuery,` right after the existing `filterLines,` line in that import:
```tsx
  filterLines,
  buildLogQuery,
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter web test logDisplay 2>&1 | tail -12`
Expected: PASS. (Typecheck is deferred to Task 5 since `detectLevel`/`splitHighlight`/`distinctPods` land in Tasks 3–4. If you added them to the import already and want a clean typecheck now, complete Tasks 3–4 first — they're independent of this one.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/logs/logDisplay.ts apps/web/src/panels/logs/logDisplay.test.ts apps/web/src/panels/logs/LogsPanel.tsx
git commit -m "refactor(logs): filterLines takes a filters bag (hideProbes/errorsOnly/query)"
```

---

## Task 3: `detectLevel` — log-level detection (TDD)

**Files:**
- Modify: `apps/web/src/panels/logs/logDisplay.ts`
- Test: `apps/web/src/panels/logs/logDisplay.test.ts`

- [ ] **Step 1: Write the failing tests.** Add `detectLevel` to the import list, then append:

```ts
describe("detectLevel", () => {
  it("detects error/fatal/panic as error", () => {
    expect(detectLevel("ERROR boom")).toBe("error");
    expect(detectLevel("fatal: nope")).toBe("error");
    expect(detectLevel("panic: x")).toBe("error");
  });
  it("detects warn/warning", () => {
    expect(detectLevel("WARN low disk")).toBe("warn");
    expect(detectLevel("warning: deprecated")).toBe("warn");
  });
  it("detects info and debug", () => {
    expect(detectLevel("INFO started")).toBe("info");
    expect(detectLevel("debug trace here")).toBe("debug");
  });
  it("returns null when no level token is present", () => {
    expect(detectLevel("just a plain line")).toBeNull();
  });
  it("prioritizes error over lower levels", () => {
    expect(detectLevel("INFO then ERROR")).toBe("error");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter web test logDisplay 2>&1 | tail -15`
Expected: FAIL — `detectLevel is not a function`.

- [ ] **Step 3: Implement.** Add to `logDisplay.ts`:

```ts
/** Conventional log levels recognized for coloring. */
export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * Detect a conventional level token in a line (word-boundary, case-insensitive),
 * or null. Priority: error (incl. fatal/panic) → warn → info → debug. Used only
 * for coloring; the substring `isErrorLine` still drives the errors-only filter.
 */
export function detectLevel(text: string): LogLevel | null {
  if (/\b(?:error|fatal|panic)\b/i.test(text)) return "error";
  if (/\b(?:warn|warning)\b/i.test(text)) return "warn";
  if (/\binfo\b/i.test(text)) return "info";
  if (/\b(?:debug|trace)\b/i.test(text)) return "debug";
  return null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter web test logDisplay 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/logs/logDisplay.ts apps/web/src/panels/logs/logDisplay.test.ts
git commit -m "feat(logs): detectLevel — classify a line's log level for coloring"
```

---

## Task 4: `splitHighlight` + `distinctPods` (TDD)

**Files:**
- Modify: `apps/web/src/panels/logs/logDisplay.ts`
- Test: `apps/web/src/panels/logs/logDisplay.test.ts`

- [ ] **Step 1: Write the failing tests.** Add `splitHighlight` and `distinctPods` to the import list, then append:

```ts
describe("splitHighlight", () => {
  it("no ranges → one plain segment", () => {
    expect(splitHighlight("hello", [])).toEqual([{ text: "hello", mark: false }]);
  });
  it("one mid-string range → plain/mark/plain", () => {
    expect(splitHighlight("hello", [[1, 3]])).toEqual([
      { text: "h", mark: false },
      { text: "el", mark: true },
      { text: "lo", mark: false },
    ]);
  });
  it("range at start and end", () => {
    expect(splitHighlight("abcd", [[0, 1], [3, 4]])).toEqual([
      { text: "a", mark: true },
      { text: "bc", mark: false },
      { text: "d", mark: true },
    ]);
  });
  it("overlapping ranges are clamped, not duplicated", () => {
    expect(splitHighlight("abcde", [[0, 3], [2, 4]])).toEqual([
      { text: "abc", mark: true },
      { text: "d", mark: true },
      { text: "e", mark: false },
    ]);
  });
});

describe("distinctPods", () => {
  it("returns unique pods in first-seen order", () => {
    const ls = [mkLine("a", "p1"), mkLine("b", "p2"), mkLine("c", "p1")];
    expect(distinctPods(ls)).toEqual(["p1", "p2"]);
  });
  it("empty → []", () => {
    expect(distinctPods([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter web test logDisplay 2>&1 | tail -15`
Expected: FAIL — `splitHighlight`/`distinctPods` not functions.

- [ ] **Step 3: Implement.** Add to `logDisplay.ts`:

```ts
/** A run of text that is either plain or highlighted (a query match). */
export interface TextSegment { text: string; mark: boolean }

/**
 * Split `text` into plain/marked segments using highlight ranges `[start,end)`.
 * Ranges may be unsorted or overlapping; they are sorted and clamped so no
 * character is emitted twice. Returns a single plain segment when no ranges.
 */
export function splitHighlight(text: string, ranges: Array<[number, number]>): TextSegment[] {
  if (ranges.length === 0) return [{ text, mark: false }];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const segs: TextSegment[] = [];
  let pos = 0;
  for (const [start, end] of sorted) {
    const s = Math.max(pos, start);
    if (s > pos) segs.push({ text: text.slice(pos, s), mark: false });
    if (end > s) {
      segs.push({ text: text.slice(s, end), mark: true });
      pos = end;
    }
  }
  if (pos < text.length) segs.push({ text: text.slice(pos), mark: false });
  return segs;
}

/** Distinct `sourcePod` names across the lines, in first-seen order. */
export function distinctPods(lines: LogLine[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (!seen.has(l.sourcePod)) {
      seen.add(l.sourcePod);
      out.push(l.sourcePod);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter web test logDisplay 2>&1 | tail -10`
Expected: PASS (all logDisplay tests green).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/logs/logDisplay.ts apps/web/src/panels/logs/logDisplay.test.ts
git commit -m "feat(logs): splitHighlight (mark segments) + distinctPods helpers"
```

---

## Task 5: Wire scan controls into the Logs panel UI

**Files:**
- Modify: `apps/web/src/panels/logs/LogsPanel.tsx`

(No unit test — verified by typecheck/build + Playwright + Docker. The logic this UI calls is already covered by Tasks 1–4.)

- [ ] **Step 0: Import the helper functions this task uses.** In `LogsPanel.tsx`, add `detectLevel`, `splitHighlight`, and `distinctPods` to the `./logDisplay` import (they exist as of Tasks 3–4). Insert after the `buildLogQuery,` line added in Task 2:
```tsx
  buildLogQuery,
  detectLevel,
  splitHighlight,
  distinctPods,
```

- [ ] **Step 1: Add the toolbar icons to the import.** In `LogsPanel.tsx`, extend the `lucide-react` import (currently `Search, WrapText, HeartOff, Play, Pause, Trash2, X, ArrowDown, AlignLeft, Sparkles`) to also include `Regex` and `CircleAlert`:

```tsx
import {
  Search,
  WrapText,
  HeartOff,
  Play,
  Pause,
  Trash2,
  X,
  ArrowDown,
  AlignLeft,
  Sparkles,
  Regex,
  CircleAlert,
} from "lucide-react";
```

- [ ] **Step 2: Add the regex/errors-only toggles + invalid hint + count to the toolbar.** In the toolbar `<div className="flex items-center gap-2 border-b px-3 py-1.5">`, (a) give the filter input wrapper a red ring when the query is invalid, (b) add a "regex" toggle and an "errors-only" toggle, and (c) add the `K / N` count. Replace the filter wrapper opening div:

```tsx
              <div
                className={`flex w-64 items-center gap-1.5 rounded-md border px-2 focus-within:ring-2 focus-within:ring-ring ${
                  query.error ? "border-destructive ring-1 ring-destructive" : ""
                }`}
                style={{ background: "var(--surface-sunken)", height: 28 }}
              >
```
Immediately after the filter wrapper's closing `</div>` (the one that closes the search box), insert the two toggles:
```tsx
              <Button
                variant={useRegex ? "secondary" : "ghost"}
                size="icon-sm"
                aria-label="Use regular expression"
                aria-pressed={useRegex}
                title="Regex filter"
                onClick={() => setUseRegex((r) => !r)}
              >
                <Regex />
              </Button>
              <Button
                variant={errorsOnly ? "secondary" : "ghost"}
                size="icon-sm"
                aria-label="Errors only"
                aria-pressed={errorsOnly}
                title="Show only error / fatal / panic lines"
                onClick={() => setErrorsOnly((e) => !e)}
              >
                <CircleAlert />
              </Button>
              {query.error ? (
                <span className="font-mono text-[10px] text-destructive" role="status">invalid pattern</span>
              ) : (
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground" aria-live="polite">
                  {filtered.length.toLocaleString()} / {lines.length.toLocaleString()} lines
                </span>
              )}
```
Keep the existing wrap / hide-probes / pause / clear buttons after these (use `ml-auto` on the first of them if you want them right-aligned — add `className="ml-auto"` to the existing Wrap button so the toggles stay left and the actions go right; this is optional polish).

- [ ] **Step 3: Highlight + level-color the row text.** In the row render (the `filtered.map((l) => …)` block), replace the line-text `<span>` (currently `${err ? "text-red-600 …" : ""}` with `{l.text}`) so it colors by detected level and renders highlight `<mark>`s. Replace the block that computes `const err = isErrorLine(l.text);` and the text span. First, in the `filtered.map` callback body, replace:
```tsx
                  const expanded = expandedLines.has(l.id);
                  const color = podColor(l.sourcePod);
                  const err = isErrorLine(l.text);
```
with:
```tsx
                  const expanded = expandedLines.has(l.id);
                  const color = podColor(l.sourcePod);
                  const level = detectLevel(l.text);
                  const levelClass =
                    level === "error" ? "text-red-600 dark:text-red-400"
                    : level === "warn" ? "text-amber-600 dark:text-amber-400"
                    : "";
                  const segments = splitHighlight(l.text, query.ranges(l.text));
```
Then replace the text `<span>` element:
```tsx
                      <span
                        className={`flex-1 ${
                          wrapLines || expanded ? "whitespace-pre-wrap break-all" : "truncate"
                        } ${err ? "text-red-600 dark:text-red-400" : ""}`}
                      >
                        {l.text}
                      </span>
```
with:
```tsx
                      <span
                        className={`flex-1 ${
                          wrapLines || expanded ? "whitespace-pre-wrap break-all" : "truncate"
                        } ${levelClass}`}
                      >
                        {segments.map((seg, i) =>
                          seg.mark ? (
                            <mark key={i} className="rounded-sm bg-yellow-300/70 text-black dark:bg-yellow-400/80">
                              {seg.text}
                            </mark>
                          ) : (
                            <span key={i}>{seg.text}</span>
                          ),
                        )}
                      </span>
```

- [ ] **Step 4: Collapse the pod column for single-pod streams.** Just before the `return (` of the component (or near the other derived values after `filtered`), add:
```tsx
  const collapsePod = distinctPods(lines).length <= 1;
```
Then in the row, wrap the pod-name `<span>` (the `w-[150px]` one showing `{l.sourcePod}`) in a conditional so it's omitted when collapsed:
```tsx
                      {!collapsePod && (
                        <span
                          className="w-[150px] shrink-0 truncate"
                          style={{ color }}
                          title={l.sourcePod}
                        >
                          {l.sourcePod}
                        </span>
                      )}
```
(The row's left border already carries the pod color, so identity is still visible when collapsed.)

- [ ] **Step 5: Verify typecheck + build**

Run: `pnpm --filter web typecheck && pnpm --filter web build 2>&1 | tail -4`
Expected: PASS. If `isErrorLine` is now unused in `LogsPanel.tsx`, remove it from the import to satisfy `noUnusedLocals`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/panels/logs/LogsPanel.tsx
git commit -m "feat(logs): errors-only + regex toggles, match highlight + count, level color, collapse pod column"
```

---

## Task 6: Verify live + Docker rebuild

**Files:** none (verification only)

- [ ] **Step 1: Full web test + typecheck**

Run: `pnpm --filter web typecheck && pnpm --filter web test 2>&1 | grep -E "Test Files|Tests "`
Expected: all PASS.

- [ ] **Step 2: Rebuild the running container**

Run: `docker compose up -d --build`
Expected: `rigel-web` rebuilt, serving on :8787.

- [ ] **Step 3: Playwright re-drive** (reuse `/tmp/logs-analyze/probe.mjs` or a short script): open `/logs`, pick a deployment, confirm the new toolbar (regex + errors-only toggles, `K / N` count), type a filter and confirm `<mark>` highlights appear, toggle errors-only and confirm the list narrows, and confirm the pod column is hidden for a single-replica deployment. Screenshot to `/tmp/logs-analyze/p1-*.png`.

- [ ] **Step 4: Update the Outline doc.** Create/extend a "Logs panel" doc in the Rigel Outline collection (id `f9bbcd7a-173c-4827-a709-f86082933031`) describing the scan controls (errors-only, regex, highlight + count, level color, collapsing pod column).

---

## Self-review notes (addressed)

- **Spec coverage (Phase 1):** errors-only (Task 2/5), match highlight + count (Tasks 1,4,5), regex + invalid handling (Tasks 1,5), level coloring (Tasks 3,5), collapse pod column (Tasks 4,5) — all covered. Server/protocol untouched (correct for Phase 1).
- **Type consistency:** `LogQuery` (`error`/`test`/`ranges`), `FilterOptions` (`hideProbes`/`errorsOnly`/`query`), `LogLevel`, `TextSegment` (`text`/`mark`) are used identically across `logDisplay.ts`, its tests, and `LogsPanel.tsx`. `filterLines` new signature is updated at its sole caller in Task 2 Step 4.
- **Refactor-not-duplicate:** `filterLines` is extended (options bag) rather than forked; new helpers have distinct purposes.
- **Ordering:** every commit typechecks. Task 2 imports only `buildLogQuery` (exists from Task 1); `detectLevel`/`splitHighlight`/`distinctPods` are imported in Task 5 Step 0, after Tasks 3–4 created them. Task 2 verifies via `test logDisplay` (vitest doesn't typecheck the `.tsx`); the first full typecheck runs in Task 5 Step 5 once all symbols exist.
