# Scheduled Cluster Digests — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user subscribe to a recurring cluster digest ("how did my cluster do overnight?") delivered to a connected channel (Signal/Matrix/webhook) on a schedule + lookback they pick, assembled and sent by the in-cluster agent.

**Architecture:** Subscriptions live in the `assistant-config` ConfigMap (server writes them, mirroring alert rules). The agent owns scheduling, assembly, an optional AI headline, the send, and per-subscription `lastSentAt` (in `assistant-state`). A new rolling incident history in `assistant-state` gives the digest a complete picture. The recurring timer rides the agent's existing ~30s poll loop (no CronJob); the tick loop is split into an always-on observe+report phase and an `enabled`-gated remediate phase so digests fire even when remediation is paused.

**Tech Stack:** TypeScript monorepo. `agent/` (Node, in-cluster), `apps/server` (Node+Hono), `apps/web` (React 19 + Vite + shadcn), `packages/k8s` (shared types). Tests: vitest. Spec: `docs/superpowers/specs/2026-06-30-scheduled-digests-design.md`.

**Branch:** `feature/scheduled-digests` (already created).

---

## File map

| File | Responsibility | Create/Modify |
|---|---|---|
| `packages/k8s/src/digest.ts` | Shared `DigestSubscription` type + parse/serialize/next/normalize (server + web) | Create |
| `packages/k8s/src/digest.test.ts` | Tests for the above | Create |
| `packages/k8s/src/assistant.ts` | Decode `digestState` into `AssistantClusterState` (web reads last-sent + preview) | Modify |
| `packages/k8s/src/index.ts` | Re-export the new digest module | Modify |
| `agent/src/state.ts` | `IncidentRecord`/`DigestState` types + `AssistantState` fields + `recordIncident`/`resolveIncident`/`dispositionFromAudit` | Modify |
| `agent/src/runtimeConfig.ts` | Extract `parseHHMM`; add `digests`/`digestRunNow` to `RuntimeConfig`; parse them | Modify |
| `agent/src/digest.ts` | `DigestSubscription` mirror + tz helpers + `isDigestDue` + `assembleDigestData` + `renderDigestText` + `generateDigestHeadline` + `evaluateDigests` | Create |
| `agent/src/digest.test.ts` | Tests (incl. DST) | Create |
| `agent/src/index.ts` | Two-phase tick split + incident-history hooks + `evaluateDigests` call | Modify |
| `apps/server/src/assistant.ts` | `saveDigest`/`deleteDigest`/`toggleDigest`/`sendDigestNow` actions + `mutateDigests` | Modify |
| `apps/web/src/lib/api.ts` | Mirror the action union + request fields | Modify |
| `apps/web/src/panels/assistant/useAssistant.ts` | Parse `digests` + decode `digestState` into `AssistantDerived` | Modify |
| `apps/web/src/panels/assistant/AssistantContext.tsx` | Add `"reports"` to `TabKey` | Modify |
| `apps/web/src/panels/assistant/components/TabBar.tsx` | Add the Reports tab entry | Modify |
| `apps/web/src/panels/assistant/components/TabContent.tsx` | Route `"reports"` → `ReportsTab` | Modify |
| `apps/web/src/panels/assistant/tabs/ReportsTab.tsx` | The Reports tab UI (Pencil-gated) | Create |

**Test commands:** `pnpm --filter @rigel/k8s test`, `pnpm --filter @rigel/agent test`, `pnpm --filter @rigel/server test`, `pnpm --filter web test`. Typecheck: `pnpm --filter <pkg> typecheck`. Run a single agent test: `pnpm --filter @rigel/agent test digest`.

---

## Phase 0 — Pencil design (GATES the web UI, runs in parallel with backend)

### Task 0: Design the Reports tab in Pencil

The web UI must be designed in Pencil before any TSX (the .pen is the source of truth; the implementation reproduces it screen-for-screen). This task produces frames + user sign-off; it blocks Tasks 16–17 only, not the backend.

- [ ] **Step 1:** Call `mcp__pencil__get_editor_state` with `include_schema: true` to load the current `.pen` file + schema. Identify the existing design system tokens/components used by the Assistant panel.
- [ ] **Step 2:** Design two frames with `mcp__pencil__batch_design`:
  1. **Digest list** — a list of subscription rows, each showing: label, channel icon/name, a human schedule line ("Daily at 7:00 AM EDT" / "Mon, Wed at 6:30 AM"), last-sent time, an enable toggle, and edit / delete / **Send now** / **Preview** affordances. Plus an empty state and an "Add digest" button.
  2. **Create/edit digest form** (a Dialog) — fields: label (text); channel (dropdown, only connected channels); cadence (Daily / Weekly / Custom with day chips Sun–Sat); send time (time input); timezone (defaults to the user's, editable); lookback (radio: "Since the last digest" vs "Fixed window" + an hours number); enabled toggle; Save / Cancel; and a "Preview" affordance that shows the rendered digest text.
- [ ] **Step 3:** `mcp__pencil__get_screenshot` each frame; record the frame ids.
- [ ] **Step 4:** Present the screenshots to the user for sign-off. Update per feedback. Record the final frame ids in this plan's Task 17 before implementing.

---

## Phase 1 — Shared digest types (`packages/k8s`)

### Task 1: `DigestSubscription` type + parse/serialize

**Files:**
- Create: `packages/k8s/src/digest.ts`
- Test: `packages/k8s/src/digest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/k8s/src/digest.test.ts
import { describe, it, expect } from "vitest";
import { parseDigests, serializeDigests, type DigestSubscription } from "./digest.js";

const sub: DigestSubscription = {
  id: "a", enabled: true, label: "Morning", channel: "signal",
  days: [0, 1, 2, 3, 4, 5, 6], time: "07:00", timezone: "America/Toronto",
  lookback: { mode: "sinceLast" }, createdAt: "2026-06-30T00:00:00.000Z",
};

describe("parseDigests", () => {
  it("round-trips a valid list", () => {
    expect(parseDigests(serializeDigests([sub]))).toEqual([sub]);
  });
  it("returns [] for empty/garbage", () => {
    expect(parseDigests(undefined)).toEqual([]);
    expect(parseDigests("not json")).toEqual([]);
    expect(parseDigests("{}")).toEqual([]);
  });
  it("drops entries missing required fields", () => {
    const bad = JSON.stringify([{ id: "x" }, sub]);
    expect(parseDigests(bad)).toEqual([sub]);
  });
  it("coerces fixed lookback and defaults enabled to true", () => {
    const raw = JSON.stringify([{ ...sub, enabled: undefined, lookback: { mode: "fixed", hours: 8 } }]);
    const out = parseDigests(raw);
    expect(out[0].enabled).toBe(true);
    expect(out[0].lookback).toEqual({ mode: "fixed", hours: 8 });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @rigel/k8s test digest`
Expected: FAIL — cannot find module `./digest.js`.

- [ ] **Step 3: Implement `packages/k8s/src/digest.ts` (types + parse/serialize)**

```ts
// packages/k8s/src/digest.ts
// Scheduled cluster digests — the domain type + pure helpers shared by the server
// (which stores subscriptions in assistant-config) and the web panel (which lists
// them). The agent owns a mirror of these shapes in agent/src/digest.ts (wire
// contract), exactly as agent/src/alerts.ts mirrors packages/k8s/src/alerts.ts.

export type DigestChannel = "webhook" | "signal" | "matrix";

export type DigestLookback =
  | { mode: "sinceLast" }
  | { mode: "fixed"; hours: number };

export interface DigestSubscription {
  id: string;
  enabled: boolean;
  label: string;
  channel: DigestChannel;
  /** Days of the week this fires, 0=Sun..6=Sat. daily = [0..6]. */
  days: number[];
  /** "HH:MM" send time, interpreted in `timezone`. */
  time: string;
  /** IANA timezone, e.g. "America/Toronto". */
  timezone: string;
  lookback: DigestLookback;
  createdAt: string;
}

const CHANNELS = new Set<DigestChannel>(["webhook", "signal", "matrix"]);

/** "HH:MM" 24h, both fields in range. */
function isValidTime(t: unknown): t is string {
  if (typeof t !== "string") return false;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return false;
  return Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

/** Non-empty subset of 0..6, deduped + sorted. Returns null when invalid. */
function cleanDays(d: unknown): number[] | null {
  if (!Array.isArray(d)) return null;
  const set = new Set<number>();
  for (const x of d) {
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > 6) return null;
    set.add(x);
  }
  if (set.size === 0) return null;
  return [...set].sort((a, b) => a - b);
}

/** True when the runtime can resolve this IANA zone. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function cleanLookback(l: unknown): DigestLookback | null {
  if (!l || typeof l !== "object") return null;
  const o = l as { mode?: unknown; hours?: unknown };
  if (o.mode === "sinceLast") return { mode: "sinceLast" };
  if (o.mode === "fixed" && typeof o.hours === "number" && o.hours > 0 && o.hours <= 168) {
    return { mode: "fixed", hours: Math.floor(o.hours) };
  }
  return null;
}

/** Tolerant parse of the `digests` JSON string. Drops anything malformed. */
export function parseDigests(json: string | undefined | null): DigestSubscription[] {
  if (!json) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: DigestSubscription[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<DigestSubscription>;
    const days = cleanDays(r.days);
    const lookback = cleanLookback(r.lookback);
    if (
      typeof r.id !== "string" || typeof r.label !== "string" ||
      !CHANNELS.has(r.channel as DigestChannel) || !isValidTime(r.time) ||
      !isValidTimezone(r.timezone) || !days || !lookback
    ) continue;
    out.push({
      id: r.id,
      enabled: r.enabled !== false,
      label: r.label,
      channel: r.channel as DigestChannel,
      days,
      time: r.time as string,
      timezone: r.timezone as string,
      lookback,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    });
  }
  return out;
}

export function serializeDigests(list: DigestSubscription[]): string {
  return JSON.stringify(list);
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @rigel/k8s test digest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/digest.ts packages/k8s/src/digest.test.ts
git commit -m "feat(k8s): DigestSubscription type + tolerant parse/serialize"
```

### Task 2: `normalizeDigest` + `nextDigests` + `digestScheduleSummary`

**Files:**
- Modify: `packages/k8s/src/digest.ts`
- Modify: `packages/k8s/src/digest.test.ts`
- Modify: `packages/k8s/src/index.ts` (re-export)

- [ ] **Step 1: Add failing tests**

```ts
// append to packages/k8s/src/digest.test.ts
import { normalizeDigest, nextDigests, digestScheduleSummary } from "./digest.js";

describe("normalizeDigest", () => {
  const base = { label: "Morning", channel: "signal" as const, days: [1, 3], time: "07:00",
    timezone: "America/Toronto", lookback: { mode: "sinceLast" as const } };
  it("stamps id + createdAt + enabled", () => {
    const r = normalizeDigest(base, "id-1", Date.UTC(2026, 5, 30));
    expect(r.id).toBe("id-1");
    expect(r.enabled).toBe(true);
    expect(r.createdAt).toBe("2026-06-30T00:00:00.000Z");
  });
  it("rejects bad timezone / time / days / channel", () => {
    expect(() => normalizeDigest({ ...base, timezone: "Mars/Phobos" }, "i", 0)).toThrow();
    expect(() => normalizeDigest({ ...base, time: "25:00" }, "i", 0)).toThrow();
    expect(() => normalizeDigest({ ...base, days: [] }, "i", 0)).toThrow();
    expect(() => normalizeDigest({ ...base, channel: "sms" as never }, "i", 0)).toThrow();
  });
});

describe("nextDigests", () => {
  const a = normalizeDigest({ label: "A", channel: "signal", days: [1], time: "07:00",
    timezone: "UTC", lookback: { mode: "sinceLast" } }, "a", 0);
  it("adds, toggles, deletes", () => {
    let list = nextDigests([], { op: "add", sub: a });
    expect(list).toHaveLength(1);
    list = nextDigests(list, { op: "toggle", id: "a", enabled: false });
    expect(list[0].enabled).toBe(false);
    list = nextDigests(list, { op: "delete", id: "a" });
    expect(list).toEqual([]);
  });
});

describe("digestScheduleSummary", () => {
  it("renders daily", () => {
    const s = normalizeDigest({ label: "A", channel: "signal", days: [0,1,2,3,4,5,6], time: "07:00",
      timezone: "UTC", lookback: { mode: "sinceLast" } }, "a", 0);
    expect(digestScheduleSummary(s)).toBe("Daily at 07:00 (UTC)");
  });
  it("renders selected days", () => {
    const s = normalizeDigest({ label: "A", channel: "signal", days: [1,3], time: "06:30",
      timezone: "UTC", lookback: { mode: "sinceLast" } }, "a", 0);
    expect(digestScheduleSummary(s)).toBe("Mon, Wed at 06:30 (UTC)");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter @rigel/k8s test digest`
Expected: FAIL — `normalizeDigest` not exported.

- [ ] **Step 3: Implement the three functions in `packages/k8s/src/digest.ts`**

```ts
// append to packages/k8s/src/digest.ts

export interface DigestInput {
  label: string;
  channel: DigestChannel;
  days: number[];
  time: string;
  timezone: string;
  lookback: DigestLookback;
}

/** Validate + stamp a user-submitted subscription. Throws on bad shape (server-side). */
export function normalizeDigest(input: DigestInput, id: string, nowMs: number): DigestSubscription {
  if (typeof input?.label !== "string" || input.label.trim() === "") throw new Error("digest needs a label");
  if (!CHANNELS.has(input.channel)) throw new Error(`invalid digest channel: ${String(input.channel)}`);
  if (!isValidTime(input.time)) throw new Error(`invalid digest time: ${String(input.time)}`);
  if (!isValidTimezone(input.timezone)) throw new Error(`invalid digest timezone: ${String(input.timezone)}`);
  const days = cleanDays(input.days);
  if (!days) throw new Error("digest needs at least one weekday (0–6)");
  const lookback = cleanLookback(input.lookback);
  if (!lookback) throw new Error("invalid digest lookback");
  return {
    id, enabled: true, label: input.label.trim(), channel: input.channel,
    days, time: input.time.trim(), timezone: input.timezone.trim(), lookback,
    createdAt: new Date(nowMs).toISOString(),
  };
}

/** Pure add/delete/toggle of the subscription list. */
export function nextDigests(
  list: DigestSubscription[],
  op:
    | { op: "add"; sub: DigestSubscription }
    | { op: "delete"; id: string }
    | { op: "toggle"; id: string; enabled: boolean },
): DigestSubscription[] {
  if (op.op === "add") return [...list.filter((s) => s.id !== op.sub.id), op.sub];
  if (op.op === "delete") return list.filter((s) => s.id !== op.id);
  return list.map((s) => (s.id === op.id ? { ...s, enabled: op.enabled } : s));
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A human one-liner for the panel, e.g. "Mon, Wed at 06:30 (UTC)". */
export function digestScheduleSummary(sub: DigestSubscription): string {
  const when = sub.days.length === 7 ? "Daily" : sub.days.map((d) => DAY_NAMES[d]).join(", ");
  return `${when} at ${sub.time} (${sub.timezone})`;
}
```

- [ ] **Step 4: Re-export from the package index**

In `packages/k8s/src/index.ts`, add alongside the other `export *` lines:

```ts
export * from "./digest.js";
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @rigel/k8s test digest && pnpm --filter @rigel/k8s typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/k8s/src/digest.ts packages/k8s/src/digest.test.ts packages/k8s/src/index.ts
git commit -m "feat(k8s): normalizeDigest + nextDigests + schedule summary"
```

---

## Phase 2 — Shared state decode (`packages/k8s`)

### Task 3: Decode `digestState` into `AssistantClusterState`

**Files:**
- Modify: `packages/k8s/src/assistant.ts` (the `AssistantClusterState` interface + `decodeClusterState`)
- Test: extend the existing assistant decode test (find it with `ls packages/k8s/src/assistant*.test.ts`)

> First read `packages/k8s/src/assistant.ts` to find the `AssistantClusterState` interface and `decodeClusterState`. It already decodes `pullRequests` — mirror that exactly for `digestState`. Only `digestState` is decoded for the web (last-sent + preview); the incident history stays agent-internal and is never decoded here.

- [ ] **Step 1: Add a failing test** (in the existing assistant decode test file)

```ts
it("decodes digestState (lastSentAt + lastPreview)", () => {
  const raw = JSON.stringify({
    updatedAt: "2026-06-30T07:00:00.000Z", audit: [], queue: [], report: "",
    digestState: {
      lastSentAt: { a: "2026-06-30T07:00:00.000Z" },
      lastPreview: { id: "a", at: "2026-06-30T06:59:00.000Z", text: "All clear." },
    },
  });
  const s = decodeClusterState(raw);
  expect(s?.digestState?.lastSentAt.a).toBe("2026-06-30T07:00:00.000Z");
  expect(s?.digestState?.lastPreview?.text).toBe("All clear.");
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter @rigel/k8s test assistant`
Expected: FAIL — `digestState` undefined on the decoded type.

- [ ] **Step 3: Implement.** Add to `packages/k8s/src/assistant.ts`:

```ts
export interface AssistantDigestState {
  lastSentAt: Record<string, string>;
  lastRunNowToken?: string;
  lastPreview?: { id: string; at: string; text: string };
}
```

Add `digestState?: AssistantDigestState;` to the `AssistantClusterState` interface (next to `pullRequests`). In `decodeClusterState`, after the `pullRequests` decode, add a tolerant decode:

```ts
const digestState = decoded.digestState && typeof decoded.digestState === "object"
  ? {
      lastSentAt: (decoded.digestState.lastSentAt && typeof decoded.digestState.lastSentAt === "object")
        ? decoded.digestState.lastSentAt as Record<string, string> : {},
      lastRunNowToken: typeof decoded.digestState.lastRunNowToken === "string"
        ? decoded.digestState.lastRunNowToken : undefined,
      lastPreview: (decoded.digestState.lastPreview && typeof decoded.digestState.lastPreview === "object")
        ? decoded.digestState.lastPreview as { id: string; at: string; text: string } : undefined,
    }
  : undefined;
```

Then include `digestState` in the returned object. (Match the surrounding decoder's existing style/guards — if it uses a helper, follow it.)

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @rigel/k8s test assistant && pnpm --filter @rigel/k8s typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/assistant.ts packages/k8s/src/*assistant*.test.ts
git commit -m "feat(k8s): decode digestState (lastSentAt + preview) for the web"
```

---

## Phase 3 — Agent state helpers (`agent/src/state.ts`)

### Task 4: `IncidentRecord` / `DigestState` types + `AssistantState` fields

**Files:**
- Modify: `agent/src/state.ts`

- [ ] **Step 1:** Add the types near `PullRequestRecord` (after line ~120):

```ts
/** A compact, persisted record of a confirmed incident the agent observed in the
 * window, so a scheduled digest can describe everything that happened — not only
 * what it acted on (the audit log). Deliberately tiny: NO analysis/detail blobs,
 * to protect the assistant-state ConfigMap size. Upserted by fingerprint. */
export interface IncidentRecord {
  at: string;
  lastSeenAt: string;
  fingerprint: string;
  location: string;
  reason: string;
  disposition: "autoFixed" | "queued" | "flagged" | "failed" | "resolved";
  resolvedAt?: string;
  note?: string;
}

/** Per-subscription digest send-state. Agent-owned, persisted in assistant-state. */
export interface DigestState {
  /** subscriptionId -> ISO send time. Restart-safe gating; prevents double-sends. */
  lastSentAt: Record<string, string>;
  /** Idempotency token for the server-triggered "Send now"/"Preview". */
  lastRunNowToken?: string;
  /** Last rendered preview text, for the web to show. */
  lastPreview?: { id: string; at: string; text: string };
}
```

Add two optional fields to `AssistantState` (next to `pullRequests?`):

```ts
  /** Rolling incident history for digests. Capped, newest-first. */
  incidents?: IncidentRecord[];
  /** Scheduled-digest send-state. */
  digestState?: DigestState;
```

- [ ] **Step 2: Typecheck** (no behavior yet)

Run: `pnpm --filter @rigel/agent typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add agent/src/state.ts
git commit -m "feat(agent): IncidentRecord + DigestState on AssistantState"
```

### Task 5: `recordIncident` + `resolveIncident` + `dispositionFromAudit`

**Files:**
- Modify: `agent/src/state.ts`
- Modify: `agent/src/state.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// append to agent/src/state.test.ts
import { recordIncident, touchIncident, resolveIncident, dispositionFromAudit, type AssistantState } from "./state.js";

const empty = (): AssistantState => ({ updatedAt: "", audit: [], queue: [], report: "" });

describe("recordIncident", () => {
  it("prepends a new record", () => {
    const s = recordIncident(empty(), {
      at: "t1", lastSeenAt: "t1", fingerprint: "unhealthyPod|ns|p|x",
      location: "ns/p", reason: "x", disposition: "flagged",
    }, 300);
    expect(s.incidents).toHaveLength(1);
    expect(s.incidents![0].fingerprint).toBe("unhealthyPod|ns|p|x");
  });
  it("upserts an open record by fingerprint (refresh, no dup)", () => {
    let s = recordIncident(empty(), { at: "t1", lastSeenAt: "t1", fingerprint: "fp", location: "l", reason: "r", disposition: "flagged" }, 300);
    s = recordIncident(s, { at: "t2", lastSeenAt: "t2", fingerprint: "fp", location: "l", reason: "r", disposition: "autoFixed" }, 300);
    expect(s.incidents).toHaveLength(1);
    expect(s.incidents![0].disposition).toBe("autoFixed");
    expect(s.incidents![0].at).toBe("t1");        // first-seen preserved
    expect(s.incidents![0].lastSeenAt).toBe("t2"); // refreshed
  });
  it("caps the list", () => {
    let s = empty();
    for (let i = 0; i < 5; i++) s = recordIncident(s, { at: `t${i}`, lastSeenAt: `t${i}`, fingerprint: `fp${i}`, location: "l", reason: "r", disposition: "flagged" }, 3);
    expect(s.incidents).toHaveLength(3);
  });
});

describe("touchIncident", () => {
  it("creates a flagged record when absent", () => {
    const s = touchIncident(empty(), { at: "t1", lastSeenAt: "t1", fingerprint: "fp", location: "l", reason: "r" }, 300);
    expect(s.incidents![0].disposition).toBe("flagged");
  });
  it("refreshes lastSeenAt but NEVER downgrades an existing disposition", () => {
    let s = recordIncident(empty(), { at: "t1", lastSeenAt: "t1", fingerprint: "fp", location: "l", reason: "r", disposition: "autoFixed" }, 300);
    s = touchIncident(s, { at: "t2", lastSeenAt: "t2", fingerprint: "fp", location: "l", reason: "r" }, 300);
    expect(s.incidents).toHaveLength(1);
    expect(s.incidents![0].disposition).toBe("autoFixed"); // not downgraded to flagged
    expect(s.incidents![0].lastSeenAt).toBe("t2");
  });
});

describe("resolveIncident", () => {
  it("marks the open record resolved", () => {
    let s = recordIncident(empty(), { at: "t1", lastSeenAt: "t1", fingerprint: "fp", location: "l", reason: "r", disposition: "flagged" }, 300);
    s = resolveIncident(s, "fp", "t9");
    expect(s.incidents![0].disposition).toBe("resolved");
    expect(s.incidents![0].resolvedAt).toBe("t9");
  });
});

describe("dispositionFromAudit", () => {
  it("maps outcomes", () => {
    expect(dispositionFromAudit({ at: "", fingerprint: "", incident: "", tier: "low", outcome: "success", detail: "" })).toBe("autoFixed");
    expect(dispositionFromAudit({ at: "", fingerprint: "", incident: "", tier: "low", outcome: "queued", detail: "" })).toBe("queued");
    expect(dispositionFromAudit({ at: "", fingerprint: "", incident: "", tier: "low", outcome: "failure", detail: "" })).toBe("failed");
    expect(dispositionFromAudit({ at: "", fingerprint: "", incident: "", tier: "low", outcome: "skipped", detail: "" })).toBe("flagged");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter @rigel/agent test state`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement in `agent/src/state.ts`** (mirror `recordPullRequest`/`appendAudit`):

```ts
// (AuditEntry / Outcome / IncidentRecord / AssistantState are already declared in
// this same file — no imports needed.)

/** Cap on the rolling incident history, and the max age before pruning. */
export const MAX_INCIDENTS = 300;
export const INCIDENT_MAX_AGE_MS = 14 * 24 * 3_600_000;

/** Shared cap + age-prune (newest-first, relative to a reference instant). */
function capPrune(list: IncidentRecord[], refMs: number, max: number): IncidentRecord[] {
  const cutoff = refMs - INCIDENT_MAX_AGE_MS;
  return list
    .filter((r) => {
      const t = Date.parse(r.lastSeenAt);
      return !Number.isFinite(t) || t >= cutoff;
    })
    .slice(0, max);
}

/** Upsert an incident by fingerprint, SETTING its disposition. An OPEN (unresolved)
 * record with the same fingerprint is refreshed in place (preserving first-seen
 * `at`, advancing `lastSeenAt`/`disposition`/`note`); otherwise it is prepended.
 * Used by the remediate funnel (record()). Pure — never mutates the input. */
export function recordIncident(state: AssistantState, rec: IncidentRecord, max = MAX_INCIDENTS): AssistantState {
  const existing = state.incidents ?? [];
  const idx = existing.findIndex((r) => r.fingerprint === rec.fingerprint && r.disposition !== "resolved");
  let next: IncidentRecord[];
  if (idx >= 0) {
    const cur = existing[idx];
    const merged: IncidentRecord = { ...cur, lastSeenAt: rec.lastSeenAt, disposition: rec.disposition, note: rec.note ?? cur.note };
    next = [merged, ...existing.slice(0, idx), ...existing.slice(idx + 1)];
  } else {
    next = [rec, ...existing];
  }
  return { ...state, incidents: capPrune(next, Date.parse(rec.lastSeenAt), max) };
}

/** Note an incident sighting WITHOUT changing an existing record's disposition:
 * create a "flagged" record if absent, else just refresh `lastSeenAt`. Used by the
 * always-on observe phase so it never downgrades a disposition the remediate phase
 * set (e.g. "autoFixed"/"queued"). Pure. */
export function touchIncident(
  state: AssistantState,
  sight: { at: string; lastSeenAt: string; fingerprint: string; location: string; reason: string },
  max = MAX_INCIDENTS,
): AssistantState {
  const existing = state.incidents ?? [];
  const idx = existing.findIndex((r) => r.fingerprint === sight.fingerprint && r.disposition !== "resolved");
  if (idx >= 0) {
    const cur = existing[idx];
    const merged: IncidentRecord = { ...cur, lastSeenAt: sight.lastSeenAt };
    const next = [merged, ...existing.slice(0, idx), ...existing.slice(idx + 1)];
    return { ...state, incidents: capPrune(next, Date.parse(sight.lastSeenAt), max) };
  }
  const rec: IncidentRecord = { ...sight, disposition: "flagged" };
  return { ...state, incidents: capPrune([rec, ...existing], Date.parse(sight.lastSeenAt), max) };
}

/** Mark the open record for `fingerprint` resolved (idempotent no-op otherwise). */
export function resolveIncident(state: AssistantState, fingerprint: string, at: string): AssistantState {
  const existing = state.incidents ?? [];
  let changed = false;
  const next = existing.map((r) => {
    if (r.fingerprint === fingerprint && r.disposition !== "resolved") {
      changed = true;
      return { ...r, disposition: "resolved" as const, resolvedAt: at, lastSeenAt: at };
    }
    return r;
  });
  return changed ? { ...state, incidents: next } : state;
}

/** Map an audit outcome to an incident disposition. */
export function dispositionFromAudit(entry: AuditEntry): IncidentRecord["disposition"] {
  switch (entry.outcome as Outcome) {
    case "success": return "autoFixed";
    case "queued": return "queued";
    case "failure": return "failed";
    default: return "flagged"; // "skipped"
  }
}
```

> Note: `AuditEntry` and `Outcome` are declared in this same file, so no import line is needed — delete the illustrative import above.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @rigel/agent test state && pnpm --filter @rigel/agent typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/state.ts agent/src/state.test.ts
git commit -m "feat(agent): record/touch/resolveIncident + dispositionFromAudit"
```

---

## Phase 4 — Agent config parsing (`agent/src/runtimeConfig.ts`)

### Task 6: Extract `parseHHMM`; parse `digests` + `digestRunNow` into `RuntimeConfig`

**Files:**
- Modify: `agent/src/runtimeConfig.ts`
- Modify: `agent/src/runtimeConfig.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// append to agent/src/runtimeConfig.test.ts
import { parseHHMM, parseDigestsFromConfig, parseDigestRunNow } from "./runtimeConfig.js";

describe("parseHHMM", () => {
  it("parses to minutes-of-day", () => {
    expect(parseHHMM("07:00")).toBe(420);
    expect(parseHHMM("00:30")).toBe(30);
  });
  it("returns null on garbage", () => {
    expect(parseHHMM("25:00")).toBeNull();
    expect(parseHHMM("x")).toBeNull();
  });
});

describe("parseDigestsFromConfig", () => {
  it("parses the digests key, tolerant of junk", () => {
    expect(parseDigestsFromConfig({})).toEqual([]);
    expect(parseDigestsFromConfig({ digests: "nope" })).toEqual([]);
    const one = JSON.stringify([{ id: "a", enabled: true, label: "M", channel: "signal", days: [1], time: "07:00", timezone: "UTC", lookback: { mode: "sinceLast" }, createdAt: "" }]);
    expect(parseDigestsFromConfig({ digests: one })).toHaveLength(1);
  });
});

describe("parseDigestRunNow", () => {
  it("parses a run-now token", () => {
    expect(parseDigestRunNow({})).toBeUndefined();
    expect(parseDigestRunNow({ digestRunNow: JSON.stringify({ id: "a", mode: "preview", token: "t" }) }))
      .toEqual({ id: "a", mode: "preview", token: "t" });
  });
  it("returns undefined on junk or bad mode", () => {
    expect(parseDigestRunNow({ digestRunNow: "x" })).toBeUndefined();
    expect(parseDigestRunNow({ digestRunNow: JSON.stringify({ id: "a", mode: "boom", token: "t" }) })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter @rigel/agent test runtimeConfig`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement.** In `agent/src/runtimeConfig.ts`:

(a) Add `parseHHMM` and refactor `parseWindow` to reuse it:

```ts
/** Parse "HH:MM" (24h) into minutes-of-day. Null on malformed input. */
export function parseHHMM(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
```

Replace the body of `parseWindow` to use it:

```ts
export function parseWindow(raw: string): TimeWindow | null {
  const m = /^(.+)-(.+)$/.exec(raw.trim());
  if (!m) return null;
  const startMin = parseHHMM(m[1]);
  const endMin = parseHHMM(m[2]);
  if (startMin === null || endMin === null) return null;
  return { startMin, endMin };
}
```

(b) Add the digest imports + parsers. The agent already depends on `@rigel/k8s` (e.g. `fixRunner.ts`, `repoResolve.ts`), so import the shared digest helpers directly — no local mirror (the legacy `agent/src/alerts.ts` mirror is not the pattern to copy for new code):

```ts
import { parseDigests, type DigestSubscription } from "@rigel/k8s";
```

```ts
export function parseDigestsFromConfig(data: Record<string, string>): DigestSubscription[] {
  return parseDigests(data["digests"]);
}

export interface DigestRunNow {
  id: string;
  mode: "send" | "preview";
  token: string;
}

/** Parse the server-written `digestRunNow` trigger. Undefined on absence/junk. */
export function parseDigestRunNow(data: Record<string, string>): DigestRunNow | undefined {
  const raw = data["digestRunNow"];
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as Partial<DigestRunNow>;
    if (typeof o.id === "string" && typeof o.token === "string" && (o.mode === "send" || o.mode === "preview")) {
      return { id: o.id, mode: o.mode, token: o.token };
    }
  } catch {
    // fallthrough
  }
  return undefined;
}
```

(c) Add `digests` + `digestRunNow` to the `RuntimeConfig` interface:

```ts
  digests: DigestSubscription[];
  digestRunNow?: DigestRunNow;
```

(d) In `readRuntimeConfig`'s returned object, add:

```ts
    digests: parseDigestsFromConfig(data),
    digestRunNow: parseDigestRunNow(data),
```

(e) In `disabledDefaults`, add `digests: [],` (leave `digestRunNow` undefined).

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @rigel/agent test runtimeConfig && pnpm --filter @rigel/agent typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/runtimeConfig.ts agent/src/runtimeConfig.test.ts
git commit -m "feat(agent): parse digests + digestRunNow; extract parseHHMM"
```

---

## Phase 5 — Agent digest module (`agent/src/digest.ts`)

### Task 7: Module scaffold + `DigestData` shape

**Files:**
- Create: `agent/src/digest.ts`

> Import `DigestSubscription` from `@rigel/k8s` (the agent depends on it). No local type mirror.

- [ ] **Step 1: Create the file with imports + the assembled-data shape** (no test yet — pure scaffolding consumed by later tasks):

```ts
// agent/src/digest.ts
// Scheduled cluster digests — schedule evaluation, window assembly, the
// deterministic body, an optional AI headline, and the send. Owned by the agent
// (the only component with the rolling state, the LLM path, and the channels).
import type { DigestSubscription } from "@rigel/k8s";
import type { RuntimeConfig } from "./runtimeConfig.js";
import { parseHHMM } from "./runtimeConfig.js";
import type { AssistantState, IncidentRecord, PullRequestRecord } from "./state.js";

/** The data a single digest summarizes — assembled purely from already-fetched
 * tick state, no new cluster reads. */
export interface DigestData {
  sub: DigestSubscription;
  windowStartMs: number;
  windowEndMs: number;
  incidents: IncidentRecord[];
  pullRequests: PullRequestRecord[];
  queueCount: number;
  health: { totalPods: number; totalDeployments: number; currentIncidents: number };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @rigel/agent typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add agent/src/digest.ts
git commit -m "chore(agent): digest module scaffold + DigestData shape"
```

### Task 8: Timezone math + `isDigestDue` (DST-correct)

**Files:**
- Modify: `agent/src/digest.ts`
- Create: `agent/src/digest.test.ts`

The rule: a digest fires when its most-recent scheduled slot instant (≤ now) is later than `lastSentAt`. Computing the slot instant needs a local-wall-time → UTC conversion via the zone offset. A brand-new subscription (no `lastSentAt`) is *armed* by the orchestrator (Task 11), so `isDigestDue` is only asked about armed subs.

- [ ] **Step 1: Write failing tests**

```ts
// agent/src/digest.test.ts
import { describe, it, expect } from "vitest";
import { isDigestDue } from "./digest.js";
import type { DigestSubscription } from "@rigel/k8s";

const sub = (over: Partial<DigestSubscription> = {}): DigestSubscription => ({
  id: "a", enabled: true, label: "M", channel: "signal",
  days: [0, 1, 2, 3, 4, 5, 6], time: "07:00", timezone: "America/Toronto",
  lookback: { mode: "sinceLast" }, createdAt: "", ...over,
});

// 2026-06-30 is a Tuesday. EDT = UTC-4 in summer.
const at = (iso: string) => Date.parse(iso);

describe("isDigestDue", () => {
  it("fires when now has crossed today's slot and lastSent was before it", () => {
    // armed yesterday; now is 07:00 EDT = 11:00 UTC
    expect(isDigestDue(sub(), "2026-06-29T11:00:00.000Z", at("2026-06-30T11:00:00.000Z"))).toBe(true);
  });
  it("does not fire before the slot", () => {
    // now is 06:30 EDT = 10:30 UTC
    expect(isDigestDue(sub(), "2026-06-29T11:00:00.000Z", at("2026-06-30T10:30:00.000Z"))).toBe(false);
  });
  it("does not re-fire after sending for this slot", () => {
    expect(isDigestDue(sub(), "2026-06-30T11:00:05.000Z", at("2026-06-30T11:01:00.000Z"))).toBe(false);
  });
  it("skips days not in the schedule", () => {
    // Wednesday-only sub on a Tuesday
    expect(isDigestDue(sub({ days: [3] }), "2026-06-23T11:00:00.000Z", at("2026-06-30T12:00:00.000Z"))).toBe(false);
  });
  it("is disabled-aware", () => {
    expect(isDigestDue(sub({ enabled: false }), "2026-06-29T11:00:00.000Z", at("2026-06-30T11:00:00.000Z"))).toBe(false);
  });
  it("handles DST fall-back without double-firing", () => {
    // 2026-11-01 02:00 EDT->EST fall-back. A 01:30 slot occurs; lastSent just after it must block re-fire.
    const s = sub({ time: "01:30", timezone: "America/Toronto" });
    // first 01:30 EDT = 05:30 UTC; sent at 05:30:05 UTC
    expect(isDigestDue(s, "2026-11-01T05:30:05.000Z", at("2026-11-01T06:45:00.000Z"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter @rigel/agent test digest`
Expected: FAIL — `isDigestDue` not exported.

- [ ] **Step 3: Implement the tz helpers + `isDigestDue` in `agent/src/digest.ts`:**

```ts
// append to agent/src/digest.ts

/** The zone's UTC offset (ms) at a given absolute instant. */
function tzOffsetMs(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  // 24:00 → 0 normalization that some engines emit for midnight
  const hour = p.hour === 24 ? 0 : p.hour;
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, hour, p.minute, p.second);
  return asUTC - utcMs;
}

/** The absolute instant of a local wall-clock time in `tz` (DST-aware; two-pass). */
function zonedWallToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMs(tz, naive);
  const guess = naive - off1;
  const off2 = tzOffsetMs(tz, guess);
  return naive - off2;
}

/** The local Y/M/D + weekday for an instant, in `tz`. */
function localParts(tz: string, utcMs: number): { y: number; mo: number; d: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), weekday: WD[p.weekday] };
}

/** The most recent scheduled slot instant that is ≤ now, or null when none in the
 * last 8 days (e.g. an empty `days`). */
export function mostRecentSlot(sub: DigestSubscription, now: number): number | null {
  const slot = parseHHMM(sub.time);
  if (slot === null || sub.days.length === 0) return null;
  for (let back = 0; back < 8; back++) {
    const probe = now - back * 86_400_000;
    const { y, mo, d, weekday } = localParts(sub.timezone, probe);
    if (!sub.days.includes(weekday)) continue;
    const inst = zonedWallToUtc(sub.timezone, y, mo, d, Math.floor(slot / 60), slot % 60);
    if (inst <= now) return inst;
  }
  return null;
}

/** Whether an armed subscription is due: its most-recent slot is later than its
 * last send. Callers arm a brand-new subscription before asking (Task 11). */
export function isDigestDue(sub: DigestSubscription, lastSentAtISO: string | undefined, now: number): boolean {
  if (!sub.enabled) return false;
  const slotInst = mostRecentSlot(sub, now);
  if (slotInst === null) return false;
  const last = lastSentAtISO ? Date.parse(lastSentAtISO) : NaN;
  if (!Number.isFinite(last)) return true; // unarmed → treat as due (orchestrator arms first)
  return last < slotInst;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @rigel/agent test digest && pnpm --filter @rigel/agent typecheck`
Expected: PASS (all `isDigestDue` cases incl. DST).

- [ ] **Step 5: Commit**

```bash
git add agent/src/digest.ts agent/src/digest.test.ts
git commit -m "feat(agent): DST-correct digest schedule (isDigestDue + tz math)"
```

### Task 9: `assembleDigestData` + `renderDigestText`

**Files:**
- Modify: `agent/src/digest.ts`
- Modify: `agent/src/digest.test.ts`

> `assembleDigestData` needs the tick's detection snapshot. Pass a minimal shape (`{ pods: unknown[]; deps: unknown[]; incidents: unknown[] }`) so the function stays decoupled from the full detection type — Task 12 passes the real `detection`.

- [ ] **Step 1: Write failing tests**

```ts
// append to agent/src/digest.test.ts
import { assembleDigestData, renderDigestText } from "./digest.js";
import type { AssistantState } from "./state.js";

const state = (): AssistantState => ({
  updatedAt: "", audit: [], queue: [
    { at: "2026-06-30T03:00:00.000Z", incident: "x pending", suggestion: "kubectl ...", reason: "RBAC" },
  ], report: "",
  incidents: [
    { at: "2026-06-30T02:00:00.000Z", lastSeenAt: "2026-06-30T02:05:00.000Z", fingerprint: "unhealthyPod|prod|api|CrashLoopBackOff", location: "prod/api", reason: "CrashLoopBackOff", disposition: "autoFixed" },
    { at: "2026-06-29T10:00:00.000Z", lastSeenAt: "2026-06-29T10:00:00.000Z", fingerprint: "old|x|y|z", location: "x/y", reason: "z", disposition: "resolved" }, // before window
  ],
  pullRequests: [
    { at: "2026-06-30T02:10:00.000Z", fingerprint: "unhealthyPod|prod|api|CrashLoopBackOff", filePath: "k8s/api.yaml", incident: "api crashloop", app: "prod/api", repo: "r", title: "fix api", summary: "patched", status: "open", kind: "config" },
  ],
});

const detection = { pods: [{}, {}, {}], deps: [{}], incidents: [] };

describe("assembleDigestData", () => {
  it("windows incidents + PRs by `at` (fixed lookback)", () => {
    const now = Date.parse("2026-06-30T07:00:00.000Z");
    const sub = { id: "a", enabled: true, label: "M", channel: "signal" as const, days: [2], time: "07:00", timezone: "UTC", lookback: { mode: "fixed" as const, hours: 8 }, createdAt: "" };
    const data = assembleDigestData(state(), detection, sub, now, undefined);
    expect(data.incidents).toHaveLength(1);            // the autoFixed one; the day-old one is out
    expect(data.pullRequests).toHaveLength(1);
    expect(data.queueCount).toBe(1);
    expect(data.health).toEqual({ totalPods: 3, totalDeployments: 1, currentIncidents: 0 });
  });
  it("sinceLast uses lastSentAt as the window start", () => {
    const now = Date.parse("2026-06-30T07:00:00.000Z");
    const sub = { id: "a", enabled: true, label: "M", channel: "signal" as const, days: [2], time: "07:00", timezone: "UTC", lookback: { mode: "sinceLast" as const }, createdAt: "" };
    const data = assembleDigestData(state(), detection, sub, now, "2026-06-30T01:00:00.000Z");
    expect(data.incidents).toHaveLength(1);
  });
});

describe("renderDigestText", () => {
  it("produces a deterministic body mentioning the counts", () => {
    const now = Date.parse("2026-06-30T07:00:00.000Z");
    const sub = { id: "a", enabled: true, label: "Morning digest", channel: "signal" as const, days: [2], time: "07:00", timezone: "UTC", lookback: { mode: "fixed" as const, hours: 8 }, createdAt: "" };
    const text = renderDigestText(assembleDigestData(state(), detection, sub, now, undefined));
    expect(text).toContain("Morning digest");
    expect(text).toContain("1 incident");
    expect(text).toContain("1 fix PR");
    expect(text).toContain("api");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter @rigel/agent test digest`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement in `agent/src/digest.ts`:**

```ts
// append to agent/src/digest.ts

/** A minimal view of the tick's detection — only what the health snapshot needs. */
export interface DigestDetectionView {
  pods: unknown[];
  deps: unknown[];
  incidents: unknown[];
}

const DEFAULT_FIRST_RUN_MS = 24 * 3_600_000;

/** Compute the window + filter state to it. Pure; no cluster reads. */
export function assembleDigestData(
  state: AssistantState,
  detection: DigestDetectionView,
  sub: DigestSubscription,
  now: number,
  lastSentAtISO: string | undefined,
): DigestData {
  let windowStartMs: number;
  if (sub.lookback.mode === "fixed") {
    windowStartMs = now - sub.lookback.hours * 3_600_000;
  } else {
    const last = lastSentAtISO ? Date.parse(lastSentAtISO) : NaN;
    windowStartMs = Number.isFinite(last) ? last : now - DEFAULT_FIRST_RUN_MS;
  }
  const inWindow = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= windowStartMs && t <= now;
  };
  const incidents = (state.incidents ?? []).filter((r) => inWindow(r.lastSeenAt) || inWindow(r.at));
  const pullRequests = (state.pullRequests ?? []).filter((p) => inWindow(p.at));
  return {
    sub, windowStartMs, windowEndMs: now,
    incidents, pullRequests,
    queueCount: state.queue.length,
    health: {
      totalPods: detection.pods.length,
      totalDeployments: detection.deps.length,
      currentIncidents: detection.incidents.length,
    },
  };
}

function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The always-sent deterministic body. Plain text suitable for a phone. */
export function renderDigestText(data: DigestData): string {
  const { sub, incidents, pullRequests, queueCount, health } = data;
  const byDisp = (d: IncidentRecord["disposition"]) => incidents.filter((i) => i.disposition === d).length;
  const lines: string[] = [];
  lines.push(`${sub.label}`);
  const hours = Math.max(1, Math.round((data.windowEndMs - data.windowStartMs) / 3_600_000));
  lines.push(`Window: last ${pluralize(hours, "hour")}.`);
  lines.push("");
  if (incidents.length === 0 && pullRequests.length === 0) {
    lines.push("No incidents. Cluster stayed healthy.");
  } else {
    lines.push(`${pluralize(incidents.length, "incident")}: ` +
      `${byDisp("autoFixed")} auto-fixed, ${byDisp("queued")} awaiting you, ` +
      `${byDisp("resolved")} resolved, ${byDisp("flagged")} flagged.`);
    if (pullRequests.length > 0) {
      lines.push(`${pluralize(pullRequests.length, "fix PR")} opened.`);
    }
    lines.push("");
    for (const i of incidents.slice(0, 10)) {
      const tail = i.disposition === "resolved" ? "resolved" : i.disposition;
      lines.push(`• ${i.location} — ${i.reason} (${tail})`);
    }
    for (const p of pullRequests.slice(0, 10)) {
      lines.push(`• PR: ${p.app} — ${p.title}${p.prUrl ? ` (${p.prUrl})` : ""}`);
    }
  }
  lines.push("");
  lines.push(`Now: ${health.totalPods} pods, ${health.totalDeployments} deployments, ` +
    `${pluralize(health.currentIncidents, "active issue")}` +
    (queueCount > 0 ? `, ${pluralize(queueCount, "item")} awaiting approval.` : "."));
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @rigel/agent test digest && pnpm --filter @rigel/agent typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/digest.ts agent/src/digest.test.ts
git commit -m "feat(agent): assembleDigestData + deterministic renderDigestText"
```

### Task 10: AI headline + `composeDigestMessage`

**Files:**
- Modify: `agent/src/digest.ts`
- Modify: `agent/src/digest.test.ts`

The AI is an enhancement: `composeDigestMessage` always returns the deterministic body, with a one-line AI headline prepended when the model call succeeds. On any model error it returns the body alone.

- [ ] **Step 1: Write failing tests** (mock `runModel`)

```ts
// append to agent/src/digest.test.ts
import { vi } from "vitest";
import * as runModelMod from "./runModel.js";
import { composeDigestMessage } from "./digest.js";

const rc = { worker: { provider: "claude", model: "m" }, supervisor: { provider: "claude", model: "m" } } as any;

const dataFixture = () => {
  const now = Date.parse("2026-06-30T07:00:00.000Z");
  const sub = { id: "a", enabled: true, label: "Morning digest", channel: "signal" as const, days: [2], time: "07:00", timezone: "UTC", lookback: { mode: "fixed" as const, hours: 8 }, createdAt: "" };
  return assembleDigestData(state(), detection, sub, now, undefined);
};

describe("composeDigestMessage", () => {
  it("prepends the AI headline on success", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({ isError: false, text: "A quiet night, one fix landed.", costUsd: 0, sessionId: "" } as any);
    const text = await composeDigestMessage(rc, dataFixture());
    expect(text.startsWith("A quiet night, one fix landed.")).toBe(true);
    expect(text).toContain("Morning digest"); // body still present
  });
  it("falls back to the body alone on model error", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({ isError: true, errorMessage: "no credential", text: "", costUsd: 0 } as any);
    const text = await composeDigestMessage(rc, dataFixture());
    expect(text).toContain("Morning digest");
    expect(text).not.toContain("undefined");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter @rigel/agent test digest`
Expected: FAIL — `composeDigestMessage` not exported.

- [ ] **Step 3: Implement in `agent/src/digest.ts`:**

```ts
// append to agent/src/digest.ts
import { runModel } from "./runModel.js";

const DIGEST_SYSTEM_PROMPT = `You are Rigel's cluster assistant writing the one-line opening of a scheduled digest an operator reads on their phone in the morning.

You are given a structured summary of what happened to their Kubernetes cluster during a time window. Reply with a SINGLE plain-text sentence (no markdown, no greeting, under ~140 characters) that captures the headline: was it a quiet night, were there issues, did anything still need them. Do not restate every detail — the structured body follows your sentence. If nothing happened, say so plainly.`;

function renderDigestPrompt(data: DigestData): string {
  return [
    `Cluster digest data (JSON):`,
    JSON.stringify({
      window_hours: Math.round((data.windowEndMs - data.windowStartMs) / 3_600_000),
      incidents: data.incidents.map((i) => ({ location: i.location, reason: i.reason, disposition: i.disposition })),
      fix_prs: data.pullRequests.map((p) => ({ app: p.app, title: p.title, status: p.status })),
      awaiting_approval: data.queueCount,
      now: data.health,
    }),
    ``,
    `Write the one-line headline.`,
  ].join("\n");
}

/** The AI headline, or null on any model error (caller sends the body alone). */
export async function generateDigestHeadline(rc: RuntimeConfig, data: DigestData): Promise<string | null> {
  try {
    const result = await runModel({
      role: "worker", config: rc, prompt: renderDigestPrompt(data),
      systemPrompt: DIGEST_SYSTEM_PROMPT, timeoutMs: 60_000,
    });
    if (result.isError) return null;
    const line = result.text.trim().split("\n")[0]?.trim();
    return line && line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/** The full message: deterministic body, with an AI headline prepended when available. */
export async function composeDigestMessage(rc: RuntimeConfig, data: DigestData): Promise<string> {
  const body = renderDigestText(data);
  const headline = await generateDigestHeadline(rc, data);
  return headline ? `${headline}\n\n${body}` : body;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @rigel/agent test digest && pnpm --filter @rigel/agent typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/digest.ts agent/src/digest.test.ts
git commit -m "feat(agent): AI headline + composeDigestMessage (body-only fallback)"
```

### Task 11: `evaluateDigests` orchestrator (arm, schedule, run-now, send, persist)

**Files:**
- Modify: `agent/src/digest.ts`
- Modify: `agent/src/digest.test.ts`

Behavior per tick:
1. **Run-now token:** if `rc.digestRunNow` exists and its `token` ≠ `state.digestState.lastRunNowToken`, run that subscription now — `mode:"send"` assembles + sends; `mode:"preview"` assembles + stores `lastPreview` (no send). Record the token either way. Run-now does NOT touch `lastSentAt` (so it never suppresses the schedule).
2. **Arming:** for each subscription with no `lastSentAt[id]`, set `lastSentAt[id] = nowISO` and skip (so a freshly-created digest fires at its NEXT slot, not retroactively today).
3. **Schedule:** for each armed subscription, if `isDigestDue`, assemble + send + set `lastSentAt[id] = nowISO`.

- [ ] **Step 1: Write failing tests** (mock notify + headline)

```ts
// append to agent/src/digest.test.ts
import * as notify from "./notify.js";
import { evaluateDigests } from "./digest.js";

const rcWith = (over: any) => ({
  worker: { provider: "claude", model: "m" }, supervisor: { provider: "claude", model: "m" },
  webhookUrl: undefined, signalApiUrl: "http://sig", signalNumber: "+1", signalRecipients: ["+2"],
  matrix: {}, digests: [], digestRunNow: undefined, ...over,
}) as any;

const dueSub = { id: "a", enabled: true, label: "M", channel: "signal" as const, days: [0,1,2,3,4,5,6], time: "07:00", timezone: "UTC", lookback: { mode: "sinceLast" as const }, createdAt: "" };

describe("evaluateDigests", () => {
  it("arms a new subscription without sending", async () => {
    const sig = vi.spyOn(notify, "notifySignal").mockResolvedValue();
    const now = Date.parse("2026-06-30T07:00:30.000Z");
    const s = await evaluateDigests(rcWith({ digests: [dueSub] }), state(), detection, now);
    expect(sig).not.toHaveBeenCalled();
    expect(s.digestState?.lastSentAt.a).toBeDefined();
  });
  it("sends when due (armed) and stamps lastSentAt", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({ isError: false, text: "head", costUsd: 0, sessionId: "" } as any);
    const sig = vi.spyOn(notify, "notifySignal").mockResolvedValue();
    const now = Date.parse("2026-06-30T11:00:30.000Z"); // 07:00 EDT? UTC tz here so 11:00 is past 07:00
    let st = state();
    st = { ...st, digestState: { lastSentAt: { a: "2026-06-29T07:00:00.000Z" } } };
    const s = await evaluateDigests(rcWith({ digests: [dueSub] }), st, detection, now);
    expect(sig).toHaveBeenCalledTimes(1);
    expect(s.digestState?.lastSentAt.a).toBe(new Date(now).toISOString());
  });
  it("runs a fresh run-now preview token without sending or touching lastSentAt", async () => {
    vi.spyOn(runModelMod, "runModel").mockResolvedValue({ isError: false, text: "head", costUsd: 0, sessionId: "" } as any);
    const sig = vi.spyOn(notify, "notifySignal").mockResolvedValue();
    const now = Date.parse("2026-06-30T11:00:30.000Z");
    let st = state();
    st = { ...st, digestState: { lastSentAt: { a: "2026-06-30T11:00:00.000Z" } } };
    const rc = rcWith({ digests: [dueSub], digestRunNow: { id: "a", mode: "preview", token: "tok-1" } });
    const s = await evaluateDigests(rc, st, detection, now);
    expect(sig).not.toHaveBeenCalled();
    expect(s.digestState?.lastPreview?.text).toContain("M");
    expect(s.digestState?.lastRunNowToken).toBe("tok-1");
    expect(s.digestState?.lastSentAt.a).toBe("2026-06-30T11:00:00.000Z"); // unchanged
  });
  it("ignores a stale run-now token", async () => {
    const sig = vi.spyOn(notify, "notifySignal").mockResolvedValue();
    const now = Date.parse("2026-06-30T11:00:30.000Z");
    let st = state();
    st = { ...st, digestState: { lastSentAt: { a: now + "" }, lastRunNowToken: "tok-1" } };
    const rc = rcWith({ digests: [dueSub], digestRunNow: { id: "a", mode: "send", token: "tok-1" } });
    const s = await evaluateDigests(rc, st, detection, now);
    expect(sig).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter @rigel/agent test digest`
Expected: FAIL — `evaluateDigests` not exported.

- [ ] **Step 3: Implement in `agent/src/digest.ts`:**

```ts
// append to agent/src/digest.ts
import { notifyWebhook, notifySignal, notifyMatrix } from "./notify.js";
import type { DigestState } from "./state.js";

/** Dispatch a rendered digest to the subscription's channel (best-effort). */
async function sendToChannel(rc: RuntimeConfig, channel: DigestSubscription["channel"], text: string): Promise<void> {
  if (channel === "webhook" && rc.webhookUrl) {
    await notifyWebhook(rc.webhookUrl, text);
  } else if (channel === "signal" && rc.signalApiUrl && rc.signalNumber) {
    await notifySignal(rc.signalApiUrl, rc.signalNumber, rc.signalRecipients, text);
  } else if (channel === "matrix" && rc.matrix.homeserverUrl && rc.matrix.accessToken && rc.matrix.roomId) {
    await notifyMatrix(rc.matrix.homeserverUrl, rc.matrix.accessToken, rc.matrix.roomId, text);
  }
  // channel not configured → silently skip (best-effort, like flushNotifications)
}

/**
 * Evaluate every digest subscription this tick: handle a run-now trigger, arm new
 * subscriptions, and send any that are due. Returns the new state (caller persists
 * it in the same writeState). Pure w.r.t. cluster reads — only sends notifications.
 */
export async function evaluateDigests(
  rc: RuntimeConfig,
  state: AssistantState,
  detection: DigestDetectionView,
  now: number,
): Promise<AssistantState> {
  const nowISO = new Date(now).toISOString();
  let ds: DigestState = state.digestState ?? { lastSentAt: {} };
  let next = state;
  const byId = new Map(rc.digests.map((s) => [s.id, s]));

  // 1) Run-now / preview trigger (idempotent by token).
  const trigger = rc.digestRunNow;
  if (trigger && trigger.token !== ds.lastRunNowToken) {
    const sub = byId.get(trigger.id);
    if (sub) {
      const data = assembleDigestData(next, detection, sub, now, ds.lastSentAt[sub.id]);
      const text = await composeDigestMessage(rc, data);
      if (trigger.mode === "send") {
        await sendToChannel(rc, sub.channel, text);
      } else {
        ds = { ...ds, lastPreview: { id: sub.id, at: nowISO, text } };
      }
    }
    ds = { ...ds, lastRunNowToken: trigger.token };
  }

  // 2) Arm new subscriptions (no retroactive same-day fire), then 3) send due ones.
  for (const sub of rc.digests) {
    const last = ds.lastSentAt[sub.id];
    if (last === undefined) {
      ds = { ...ds, lastSentAt: { ...ds.lastSentAt, [sub.id]: nowISO } };
      continue;
    }
    if (isDigestDue(sub, last, now)) {
      const data = assembleDigestData(next, detection, sub, now, last);
      const text = await composeDigestMessage(rc, data);
      await sendToChannel(rc, sub.channel, text);
      ds = { ...ds, lastSentAt: { ...ds.lastSentAt, [sub.id]: nowISO } };
    }
  }

  // Drop lastSentAt entries for deleted subscriptions (housekeeping).
  const liveIds = new Set(rc.digests.map((s) => s.id));
  const prunedLast: Record<string, string> = {};
  for (const [id, t] of Object.entries(ds.lastSentAt)) if (liveIds.has(id)) prunedLast[id] = t;
  ds = { ...ds, lastSentAt: prunedLast };

  next = { ...next, digestState: ds };
  return next;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @rigel/agent test digest && pnpm --filter @rigel/agent typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/digest.ts agent/src/digest.test.ts
git commit -m "feat(agent): evaluateDigests — arm, schedule, run-now, send, persist"
```

---

## Phase 6 — Agent tick wiring (`agent/src/index.ts`)

### Task 12: Two-phase tick split + incident-history hooks + digest evaluation

**Files:**
- Modify: `agent/src/index.ts`
- Modify: `agent/src/index.test.ts`

> Read `agent/src/index.ts:203-727` and `:900-985` first. The change has three parts: (a) record incident history at the existing funnel + observe points; (b) restructure the `!rc.enabled` early-return into observe/remediate phases; (c) call `evaluateDigests` before `writeState`.

- [ ] **Step 1: Write failing tests** (extend `index.test.ts`; reuse its existing kubectl/runModel/notify seams)

```ts
// add cases to agent/src/index.test.ts (follow the file's existing tick() harness)
it("records a confirmed incident to history even while paused (enabled=false)", async () => {
  // config: enabled=false; detection returns one confirmed unhealthy pod (use the
  // harness's mechanism to set confirmPolls=1 and a crashlooping pod).
  // After tick(), read the written assistant-state and assert:
  //   state.incidents has one record with disposition "flagged".
});

it("fires a due digest before writeState and stamps lastSentAt", async () => {
  // config: enabled=true; one digest subscription due now; digestState armed yesterday.
  // mock notify + runModel. After tick():
  //   notifySignal called once; state.digestState.lastSentAt[id] === this tick's ts.
});

it("upgrades a flagged incident to autoFixed when remediation acts", async () => {
  // enabled=true; a confirmed incident the remediate phase auto-fixes.
  // After tick(): the incident record disposition === "autoFixed" (single record).
});
```

> Implement these against the concrete harness in `index.test.ts` (it already builds a `Config`, `CircuitBreaker`, `LoopState` and stubs kubectl). Match its existing assertion style for reading the persisted state.

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter @rigel/agent test index`
Expected: FAIL — incidents/digestState not populated.

- [ ] **Step 3: Implement the tick restructure in `agent/src/index.ts`.**

(a) Add imports at the top:

```ts
import { evaluateDigests } from "./digest.js";
import { recordIncident, touchIncident, resolveIncident, dispositionFromAudit } from "./state.js";
```

(b) Replace the `!rc.enabled` early-return block (currently lines ~227-231) so detection + incident history + digests run regardless of `enabled`, and only remediation is gated. Concretely, restructure `tick()` body after the heartbeat-state assignment as:

```ts
  // ---- OBSERVE (always runs, even when the kill-switch is off) ----
  const detection = await detectAll(cfg, rc.autofix);
  const nsAllow = rc.limits.namespaces;
  const scoped = nsAllow.length > 0
    ? detection.incidents.filter((i) => i.namespace === "" || nsAllow.includes(i.namespace))
    : detection.incidents;
  const autoSilenced = new Set(state.autoSilenced ?? []);
  const incidents = scoped.filter((i) => {
    const fp = fingerprint(i);
    return !rc.silenced.has(fp) && !autoSilenced.has(fp);
  });

  const present = new Set(incidents.map(fingerprint));
  // Resolve incidents that cleared (history + debounce tracking).
  for (const fp of [...loop.streaks.keys()]) {
    if (!present.has(fp)) {
      state = resolveIncident(state, fp, ts);
      loop.streaks.delete(fp);
      loop.handled.delete(fp);
    }
  }
  for (const i of incidents) {
    const fp = fingerprint(i);
    loop.streaks.set(fp, (loop.streaks.get(fp) ?? 0) + 1);
  }
  const confirmed = incidents.filter((i) => {
    const fp = fingerprint(i);
    return (loop.streaks.get(fp) ?? 0) >= rc.limits.confirmPolls && !loop.handled.has(fp);
  });
  // Note every confirmed incident in history (create as "flagged" if new, else just
  // refresh lastSeenAt). touchIncident NEVER downgrades a disposition the remediate
  // phase later set via record(), so this is safe to run every tick.
  for (const i of confirmed) {
    const fp = fingerprint(i);
    state = touchIncident(state, {
      at: ts, lastSeenAt: ts, fingerprint: fp,
      location: shortFingerprint(fp), reason: fp.split("|")[3] ?? "",
    });
  }

  if (rc.enabled) {
    // ---- REMEDIATE (unchanged behavior; now nested under enabled) ----
    // ... existing tick body from the queue-reconcile block through Stage A/B,
    //     reconcileFixJobs, inbound handlers, alert live-sends ...
    // (Keep using `detection`/`incidents`/`confirmed` computed above — delete the
    //  now-duplicated re-computation that used to live here.)
  } else {
    log("kill-switch is off — observing only (digests still run)");
  }

  // ---- REPORT (always) ----
  state = await evaluateDigests(rc, state, detection, now);
  await writeState(cfg.stateConfigMap, cfg.stateNamespace, state);
  if (rc.enabled) flushNotifications(rc, notifications);
```

> This is a structural move, not a rewrite: the queue-reconcile, alert evaluation, Stage A/B, `reconcileFixJobs`, and inbound handlers all move inside the `if (rc.enabled)` block unchanged, consuming the `detection`/`incidents`/`confirmed`/`present` computed in the observe phase (delete their duplicate computation). Keep `flushNotifications` gated on `enabled` (no per-incident pings while paused). `shortFingerprint` already exists in this file (used by `record()`); reuse it for `location`.

(c) Extend `record()` (the helper at ~line 902) so every confirmed-incident disposition also updates the incident history:

```ts
function record(state: AssistantState, cfg: Config, entry: AuditEntry): AssistantState {
  let next = appendAudit(state, entry, cfg.auditMaxEntries); // existing line
  next = recordIncident(next, {
    at: entry.at, lastSeenAt: entry.at, fingerprint: entry.fingerprint,
    location: shortFingerprint(entry.fingerprint), reason: entry.fingerprint.split("|")[3] ?? "",
    disposition: dispositionFromAudit(entry),
    note: entry.proposal,
  });
  return next;
}
```

(d) Alert-rule fires: leave the existing `for (const ev of alertResult.events) notifications.push(ev.message);` loop unchanged. `AlertEvent` is `{ruleId, message}` with no incident fingerprint, so there is nothing to key an incident record on — and the same underlying pods are already captured as confirmed detector incidents in the observe phase. No incident-history hook here.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @rigel/agent test && pnpm --filter @rigel/agent typecheck`
Expected: PASS (full agent suite — the restructure must not regress existing tick tests).

- [ ] **Step 5: Commit**

```bash
git add agent/src/index.ts agent/src/index.test.ts
git commit -m "feat(agent): observe/remediate tick split + incident history + digests"
```

---

## Phase 7 — Server actions (`apps/server`)

### Task 13: `saveDigest`/`deleteDigest`/`toggleDigest`/`sendDigestNow`

**Files:**
- Modify: `apps/server/src/assistant.ts`
- Modify: `apps/server/src/assistant.test.ts`

- [ ] **Step 1: Write failing tests** (mirror the alert-mutation tests — find them with `grep -n "mutateAlerts\|saveAlert" apps/server/src/assistant.test.ts`)

```ts
// append to apps/server/src/assistant.test.ts, following the existing kubectl-mock harness
import { mutateDigests, digestRunNowUpdate } from "./assistant.js";

describe("mutateDigests", () => {
  it("adds a digest without clobbering other config keys", async () => {
    // mock readConfigMapData -> { alertRules: "[...]", digests: "[]" }
    // call mutateDigests(ctx, ns, { action: "saveDigest", digest: { label, channel, days, time, timezone, lookback } })
    // assert the applied ConfigMap JSON contains BOTH alertRules (unchanged) and a digests array of length 1 with a generated id.
  });
  it("sendDigestNow writes a fresh digestRunNow token", () => {
    const up = digestRunNowUpdate({ action: "sendDigestNow", digestId: "a", digestMode: "preview" });
    const parsed = JSON.parse(up.digestRunNow);
    expect(parsed.id).toBe("a");
    expect(parsed.mode).toBe("preview");
    expect(typeof parsed.token).toBe("string");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter @rigel/server test assistant`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement in `apps/server/src/assistant.ts`.**

(a) Extend the imports from `@rigel/k8s`:

```ts
import { parseDigests, serializeDigests, normalizeDigest, nextDigests, type DigestInput } from "@rigel/k8s";
```

(b) Add to the `AssistantAction` union:

```ts
  | "saveDigest" | "deleteDigest" | "toggleDigest" | "sendDigestNow"
```

(c) Add to `AssistantRequest`:

```ts
  // scheduled digests (saveDigest/deleteDigest/toggleDigest/sendDigestNow)
  digest?: DigestInput;     // saveDigest payload (validated server-side)
  digestId?: string;        // delete/toggle/sendDigestNow
  digestEnabled?: boolean;  // toggle
  digestMode?: "send" | "preview"; // sendDigestNow
```

(d) Add the mutation + the run-now update (mirror `mutateAlerts` exactly):

```ts
/** Read-modify-write the `digests` key of `assistant-config`. */
export async function mutateDigests(
  context: string | null,
  namespace: string,
  req: AssistantRequest,
): Promise<RunResult> {
  const existing = await readConfigMapData(context, namespace, "assistant-config");
  const list = parseDigests(existing["digests"]);
  let next;
  if (req.action === "saveDigest") {
    if (!req.digest) throw new Error("saveDigest requires a `digest` payload.");
    const sub = normalizeDigest(req.digest, crypto.randomUUID(), Date.now());
    next = nextDigests(list, { op: "add", sub });
  } else if (req.action === "deleteDigest") {
    if (!req.digestId) throw new Error("deleteDigest requires `digestId`.");
    next = nextDigests(list, { op: "delete", id: req.digestId });
  } else {
    if (!req.digestId) throw new Error("toggleDigest requires `digestId`.");
    next = nextDigests(list, { op: "toggle", id: req.digestId, enabled: req.digestEnabled === true });
  }
  return patchConfig(context, namespace, { digests: serializeDigests(next) });
}

/** Pure: the assistant-config update that triggers a one-shot digest run. The agent
 * compares the token to its persisted lastRunNowToken and runs on a fresh one. */
export function digestRunNowUpdate(req: AssistantRequest): Record<string, string> {
  if (!req.digestId) throw new Error("sendDigestNow requires `digestId`.");
  return {
    digestRunNow: JSON.stringify({
      id: req.digestId,
      mode: req.digestMode === "preview" ? "preview" : "send",
      token: crypto.randomUUID(),
    }),
  };
}
```

(e) Wire the dispatch. Find the `switch` in `handleAssistant` (~line 840) and add:

```ts
    case "saveDigest":
    case "deleteDigest":
    case "toggleDigest":
      return mutateDigests(context, namespace, req);
    case "sendDigestNow":
      return patchConfig(context, namespace, digestRunNowUpdate(req));
```

> Match how the existing cases read `context`/`namespace` (some derive `namespace` from the install ns). Mirror the `saveAlert` case exactly.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @rigel/server test assistant && pnpm --filter @rigel/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/assistant.ts apps/server/src/assistant.test.ts
git commit -m "feat(server): saveDigest/deleteDigest/toggleDigest/sendDigestNow"
```

---

## Phase 8 — Web data wiring

### Task 14: Mirror the action union + request fields in the web API client

**Files:**
- Modify: `apps/web/src/lib/api.ts`

> Read `apps/web/src/lib/api.ts` and find the `AssistantAction` union + `AssistantRequest` interface (they mirror the server's). Add the same four actions and the four `digest*` fields. No new endpoint — `postAssistant`/`useAssistantAction` already POST the whole request.

- [ ] **Step 1:** Add to the web `AssistantAction` union: `"saveDigest" | "deleteDigest" | "toggleDigest" | "sendDigestNow"`.
- [ ] **Step 2:** Add to the web `AssistantRequest` interface, importing `DigestInput` from `@rigel/k8s`:

```ts
  digest?: DigestInput;
  digestId?: string;
  digestEnabled?: boolean;
  digestMode?: "send" | "preview";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): mirror digest actions in the assistant API client"
```

### Task 15: Surface `digests` + `digestState` in `AssistantDerived`

**Files:**
- Modify: `apps/web/src/panels/assistant/useAssistant.ts`

- [ ] **Step 1:** Extend the `@rigel/k8s` import in `useAssistant.ts` with `parseDigests` and the digest types:

```ts
  parseDigests,
  type DigestSubscription,
  type AssistantDigestState,
```

- [ ] **Step 2:** Add to the `AssistantDerived` interface:

```ts
  /** Scheduled digest subscriptions, parsed from assistant-config. */
  digests: DigestSubscription[];
  /** Per-subscription send-state (last-sent + last preview), from assistant-state. */
  digestState: AssistantDigestState | null;
```

- [ ] **Step 3:** In the derived-state assembly (next to `alertRules: parseAlertRules(configData["alertRules"])` and `pullRequests: clusterState?.pullRequests ?? []`):

```ts
    digests: parseDigests(configData["digests"]),
    digestState: clusterState?.digestState ?? null,
```

- [ ] **Step 4: Typecheck + existing tests**

Run: `pnpm --filter web typecheck && pnpm --filter web test useAssistant`
Expected: PASS (or no matching test — then just typecheck).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/assistant/useAssistant.ts
git commit -m "feat(web): expose digests + digestState in AssistantDerived"
```

---

## Phase 9 — Web Reports tab (REQUIRES Task 0 sign-off)

### Task 16: Register the Reports tab

**Files:**
- Modify: `apps/web/src/panels/assistant/AssistantContext.tsx`
- Modify: `apps/web/src/panels/assistant/components/TabBar.tsx`
- Modify: `apps/web/src/panels/assistant/components/TabContent.tsx`

- [ ] **Step 1:** In `AssistantContext.tsx`, extend `TabKey`:

```ts
export type TabKey = "overview" | "needs" | "rules" | "autofix" | "agents" | "activity" | "reports" | "settings";
```

- [ ] **Step 2:** In `components/TabBar.tsx`, add to the `tabs` array (after `"activity"`):

```ts
    { id: "reports", label: "Reports" },
```

- [ ] **Step 3:** In `components/TabContent.tsx`, import `ReportsTab` and add a case:

```ts
    case "reports":
      return <ReportsTab />;
```

- [ ] **Step 4:** Create a temporary stub so it compiles (replaced in Task 17):

```ts
// apps/web/src/panels/assistant/tabs/ReportsTab.tsx
export function ReportsTab() {
  return <div className="text-sm text-muted-foreground">Reports — coming up.</div>;
}
```

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter web typecheck`

```bash
git add apps/web/src/panels/assistant/AssistantContext.tsx apps/web/src/panels/assistant/components/TabBar.tsx apps/web/src/panels/assistant/components/TabContent.tsx apps/web/src/panels/assistant/tabs/ReportsTab.tsx
git commit -m "feat(web): register the Assistant Reports tab"
```

### Task 17: Build the Reports tab UI (to the Pencil design)

**Files:**
- Modify: `apps/web/src/panels/assistant/tabs/ReportsTab.tsx`
- Test: `apps/web/src/panels/assistant/tabs/ReportsTab.test.tsx`

**Pencil frames (fill in from Task 0):** list = `<frame-id>`, form = `<frame-id>`. Reproduce them screen-for-screen. Use `Card`/`Field`/`Section`/`inputClass` from `../components/primitives`, `Button` from `@/components/ui/button`, `Dialog` from `@/components/ui/dialog` (the editor is a Dialog, not a Sheet), and `Switch` from `@/components/ui/switch` for the enable toggle. Native `<select>`/`<input>` with `inputClass` are the established form controls.

Behavior contract (data wiring, independent of exact layout):
- Read `const { d, ns, working, run } = useAssistantCtx();`
- List `d.digests`. For each, render `digestScheduleSummary(sub)` (from `@rigel/k8s`), the channel, the last-sent time from `d.digestState?.lastSentAt[sub.id]`, an enable Switch → `run({ action: "toggleDigest", namespace: ns, digestId: sub.id, digestEnabled: !sub.enabled })`, a delete → `run({ action: "deleteDigest", namespace: ns, digestId: sub.id })`, **Send now** → `run({ action: "sendDigestNow", namespace: ns, digestId: sub.id, digestMode: "send" })`, **Preview** → `run({ action: "sendDigestNow", namespace: ns, digestId: sub.id, digestMode: "preview" })` then show `d.digestState?.lastPreview` when its `id` matches.
- The create/edit Dialog collects `DigestInput` and saves via `run({ action: "saveDigest", namespace: ns, digest }, () => setOpen(false))`.
- **Channel dropdown lists only connected channels.** Derive availability from the same source the Settings panel uses: a channel is offered when its config is present. Compute locally from `d` (e.g. webhook when `d.webhookURL`, signal/matrix from the derived channel status the Settings tab already exposes). Reuse `deriveSignalBridgeStatus`/`deriveMatrixConnected` from `@rigel/k8s` against the config if `d` doesn't already expose readiness; do not duplicate that logic.
- Timezone field defaults to `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- A `sendDigestNow`/preview shows a "generating…" affordance (up to ~30s + model latency) until `d.digestState.lastPreview.at`/`lastSentAt` advances.

- [ ] **Step 1: Write a failing test** (render + dispatch shape; mock the context)

```tsx
// apps/web/src/panels/assistant/tabs/ReportsTab.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ReportsTab } from "./ReportsTab";
import * as ctx from "../AssistantContext";

const sub = { id: "a", enabled: true, label: "Morning", channel: "signal" as const, days: [0,1,2,3,4,5,6], time: "07:00", timezone: "UTC", lookback: { mode: "sinceLast" as const }, createdAt: "" };

function mockCtx(run = vi.fn()) {
  vi.spyOn(ctx, "useAssistantCtx").mockReturnValue({
    d: { digests: [sub], digestState: { lastSentAt: { a: "2026-06-30T07:00:00.000Z" } }, webhookURL: "", /* ...minimal */ } as any,
    ns: "default", working: false, run,
  } as any);
  return run;
}

describe("ReportsTab", () => {
  it("lists subscriptions with their schedule", () => {
    mockCtx();
    render(<ReportsTab />);
    expect(screen.getByText("Morning")).toBeTruthy();
    expect(screen.getByText(/Daily at 07:00/)).toBeTruthy();
  });
  it("dispatches sendDigestNow on Send now", () => {
    const run = mockCtx();
    render(<ReportsTab />);
    fireEvent.click(screen.getByRole("button", { name: /send now/i }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ action: "sendDigestNow", digestId: "a", digestMode: "send" }));
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter web test ReportsTab`
Expected: FAIL — stub renders nothing matching.

- [ ] **Step 3: Implement `ReportsTab.tsx`** to satisfy the test + reproduce the Pencil frames, following the `RulesTab`/`AlertsCard` pattern (list + Dialog form + `run` dispatch). Keep the deterministic data wiring above; the visual structure comes from the frames.

- [ ] **Step 4: Run tests + typecheck + build**

Run: `pnpm --filter web test ReportsTab && pnpm --filter web typecheck && pnpm --filter web build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/assistant/tabs/ReportsTab.tsx apps/web/src/panels/assistant/tabs/ReportsTab.test.tsx
git commit -m "feat(web): Reports tab — digest list + create/edit + send-now/preview"
```

---

## Phase 10 — Full verification + docs

### Task 18: Cross-package verification

- [ ] **Step 1:** Run every suite + typecheck + build:

```bash
pnpm --filter @rigel/k8s test && pnpm --filter @rigel/agent test && pnpm --filter @rigel/server test && pnpm --filter web test
pnpm --filter @rigel/k8s typecheck && pnpm --filter @rigel/agent typecheck && pnpm --filter @rigel/server typecheck && pnpm --filter web typecheck
pnpm --filter web build
```

Expected: all PASS. Do NOT run any kubectl mutation against a live cluster.

- [ ] **Step 2:** If anything fails, fix with the systematic-debugging skill and re-run before proceeding.

### Task 19: Outline doc + Plane tickets

- [ ] **Step 1:** Update the app's Outline doc (Rigel collection) with a "Scheduled digests" section: what it does, the schedule/lookback model, channel selection, "fires even when paused", and the Send-now/Preview affordance.
- [ ] **Step 2:** Derive Plane tickets (project Rigel / HELM) from the doc for any deferred follow-ups (e.g. a dedicated `digest` model role; showing incident history in the UI; per-digest channel test).
- [ ] **Step 3:** No commit needed (external systems).

---

## Self-review notes
- **Spec coverage:** cadence+lookback (Tasks 1, 8, 9), Assistant sub-tab (16–17), complete picture / incident history (4, 5, 12), scheduled + send-now/preview (11, 13, 17), deterministic body + AI headline (9, 10), fires when paused (12), poll-loop scheduler (8, 12), ConfigMap-size guard (4: tiny records + cap + prune), DST (8), restart-safety (11: lastSentAt + token).
- **No fallback added without sign-off:** the only degradation is the AI headline (explicitly chosen in the spec). The digest body is always deterministic.
- **Reuse:** notify functions, `runModel`/`runDiagnosis` shape, `parseWindow`→`parseHHMM`, `countFixPrBudget` window idiom, `recordPullRequest` cap idiom, `mutateAlerts`/`normalizeAlertRule`/`nextAlertRules`, `useAssistantCtx().run`/`postAssistant`, the `RulesTab`/`AlertsCard` UI pattern.
- **Open decision deferred to a ticket (not a blocker):** a dedicated `digest` model role (Task 10 uses `worker`).
