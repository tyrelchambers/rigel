# Matrix Channel (Phase 1: Connect) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the in-cluster `rigel-assistant` agent a second, independent chat channel over Matrix — the bot dials out to a homeserver, polls a room for commands, and replies — wired through a `setMatrix` server action and a `MatrixSection` connect wizard, coexisting with Signal.

**Architecture:** Mirror the existing Signal integration transport-for-transport. The agent reuses the transport-agnostic `Command`/handler core (`parseCommand`, the command handlers, `chunkText`) and adds Matrix IO (`notifyMatrix` send, `receiveMatrix` /sync) plus a pure `matrixInbound.ts` core (sync-event parsing, allowlist, event-id de-dup). Config keys live in the `assistant-config` ConfigMap (read live each tick); the bot access token lives in a Secret injected as `MATRIX_ACCESS_TOKEN`. The server gets a `setMatrix` action (mirrors `setSignal`) and a `/api/matrix` proxy for login/whoami/createRoom. The desktop app gets a `MatrixSection` state machine + a connect wizard (paths A and B).

**Tech Stack:** TypeScript, Node 22, vitest. Agent is a standalone package (`agent/`, its own kubectl + vitest). `apps/server` (Hono + Node), `apps/web` (React 19 + Vite + Tailwind v4 + @testing-library/react), shared `packages/k8s`. Matrix client-server API over `fetch`.

---

## File Structure

| File | Create/Modify | Responsibility |
| --- | --- | --- |
| `agent/src/matrixInbound.ts` | Create | Pure Matrix inbound core: `MatrixEvent`, `parseSyncEvents`, `isAllowedSender`, `SeenEventIds`, `handleMatrixInbound`. Reuses `parseCommand`/`dispatchCommand`/`chunkText` from `signalInbound.ts`. |
| `agent/src/matrixInbound.test.ts` | Create | Tests for the parsing/allowlist/de-dup/orchestration core. |
| `agent/src/signalInbound.ts` | Modify | Extract `CommandHandlers` (the transport-agnostic command subset) + `dispatchCommand`; refactor `handleInbound` to use them. `InboundHandlers extends CommandHandlers`. |
| `agent/src/notify.ts` | Modify | Add `notifyMatrix` (PUT send, chunked, best-effort) + `receiveMatrix` (GET /sync). |
| `agent/src/notify.test.ts` | Create | Tests for `notifyMatrix`/`receiveMatrix` against a stubbed `fetch`. |
| `agent/src/runtimeConfig.ts` | Modify | Add `MatrixRuntime` + `parseMatrixConfig` (config keys + token from env); embed `matrix` on `RuntimeConfig`. |
| `agent/src/runtimeConfig.test.ts` | Modify | Tests for `parseMatrixConfig`. |
| `agent/src/state.ts` | Modify | Add optional `matrixSince` cursor field to `AssistantState`. |
| `agent/src/index.ts` | Modify | Wire the Matrix outbound branch into `flushNotifications`, the Matrix inbound poll into the tick, the `since` cursor persistence, and extract `buildCommandHandlers` shared by Signal + Matrix. |
| `packages/k8s/src/matrix.ts` | Create | Pure helpers: `MATRIX_SECRET_NAME`, `matrixSecretYAML`, `matrixConfigUpdates`, config readers, `parseAllowedSenders`, `deriveMatrixConnected`, status color/label. |
| `packages/k8s/src/matrix.test.ts` | Create | Tests for the k8s Matrix helpers. |
| `packages/k8s/src/index.ts` | Modify | Re-export the new `./matrix` surface. |
| `packages/k8s/src/assistant.ts` | Modify | Add `MATRIX_ACCESS_TOKEN` env (secretKeyRef, `optional: true`) to the agent `deployment()`. |
| `packages/k8s/src/assistant.test.ts` | Modify | Assert the manifest injects the Matrix token env. |
| `apps/server/src/matrix.ts` | Create | `handleMatrix` (login/validate/createRoom) + pure request builders, mirroring `signal.ts`. |
| `apps/server/src/matrix.test.ts` | Create | Tests for the request builders + dispatch guards (no live homeserver). |
| `apps/server/src/assistant.ts` | Modify | `setMatrix` action + `setMatrixUpdates`/`setMatrixSecret` pure helpers + request fields + dispatch. |
| `apps/server/src/assistant.test.ts` | Modify | Tests for `setMatrixUpdates`/`setMatrixSecret`. |
| `apps/server/src/index.ts` | Modify | Add the `POST /api/matrix` route (mirrors `/api/signal`). |
| `apps/web/src/lib/api.ts` | Modify | `setMatrix` in the `AssistantAction` union + request fields; `matrixLogin`/`matrixValidate`/`matrixCreateRoom` helpers. |
| `apps/web/src/lib/api.matrix.test.ts` | Create | Tests for the Matrix API helpers against a stubbed `fetch`. |
| `apps/web/src/panels/settings/useSettings.ts` | Modify | Derive Matrix status + config fields from the same configmaps watch. |
| `apps/web/src/panels/settings/settings.test.ts` | Modify | Tests for the Matrix derivation reachable via the `@rigel/k8s` alias. |
| `apps/web/src/panels/settings/MatrixSection.tsx` | Create | Resting-state section (not connected / connected / error) + Enabled toggle. |
| `apps/web/src/panels/settings/MatrixSection.test.tsx` | Create | Component tests for the section states + toggle. |
| `apps/web/src/panels/settings/MatrixConnectModal.tsx` | Create | The connect wizard (paths A/B, token-vs-login toggle, allowed-senders, first contact). |
| `apps/web/src/panels/settings/MatrixConnectModal.test.tsx` | Create | Component tests for the wizard flow (which API calls fire per path/mode). |
| `apps/web/src/panels/settings/SettingsPanel.tsx` | Modify | Render `<MatrixSection>` alongside `<SignalSection>`. |

**Test commands** (cwd resets between shells — use absolute `cd` for the agent):
- Agent: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm vitest run src/<file>.test.ts` (whole suite: `pnpm vitest run`; typecheck: `pnpm typecheck`).
- k8s: `pnpm --filter @rigel/k8s test src/<file>.test.ts`.
- Server: `pnpm --filter @rigel/server test src/<file>.test.ts` (typecheck: `pnpm --filter @rigel/server typecheck`).
- Web: `pnpm --filter web test src/<path>/<file>` (typecheck: `pnpm --filter web typecheck`).

**Commit note:** code is committed normally; the `docs/` dir is gitignored, so this plan file (if ever committed) needs `git add -f`. Never `git add` the plan in a task commit.

---

### Task 1: Agent — Matrix /sync event parsing (pure core)

**Files:**
- Create: `agent/src/matrixInbound.ts`
- Test: `agent/src/matrixInbound.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// agent/src/matrixInbound.test.ts
import { describe, expect, test } from "vitest";
import { parseSyncEvents, isAllowedSender, SeenEventIds } from "./matrixInbound.js";

describe("parseSyncEvents", () => {
  const SAMPLE = {
    next_batch: "s2",
    rooms: {
      join: {
        "!room:hs": {
          timeline: {
            events: [
              { type: "m.room.message", event_id: "$a", sender: "@me:hs", origin_server_ts: 111, content: { msgtype: "m.text", body: " status " } },
              { type: "m.room.message", event_id: "$b", sender: "@me:hs", origin_server_ts: 222, content: { msgtype: "m.image", body: "pic" } }, // not text
              { type: "m.reaction", event_id: "$c", sender: "@me:hs", content: {} }, // not a message
              { type: "m.room.message", event_id: "$d", sender: "@me:hs", origin_server_ts: 333, content: { msgtype: "m.text", body: "   " } }, // empty
            ],
          },
        },
      },
    },
  };

  test("extracts text messages with id/sender/ts, skipping non-text/empty/non-message", () => {
    expect(parseSyncEvents(SAMPLE, "!room:hs")).toEqual({
      nextBatch: "s2",
      events: [{ eventId: "$a", sender: "@me:hs", body: "status", timestamp: 111 }],
    });
  });

  test("returns the next_batch but no events for a room not in the response", () => {
    expect(parseSyncEvents(SAMPLE, "!other:hs")).toEqual({ nextBatch: "s2", events: [] });
  });

  test("is defensive against malformed input", () => {
    expect(parseSyncEvents(null, "!room:hs")).toEqual({ nextBatch: "", events: [] });
    expect(parseSyncEvents({}, "!room:hs")).toEqual({ nextBatch: "", events: [] });
    expect(parseSyncEvents({ rooms: "garbage" }, "!room:hs")).toEqual({ nextBatch: "", events: [] });
  });
});

describe("isAllowedSender", () => {
  test("exact-matches a trimmed Matrix id against the allowlist", () => {
    expect(isAllowedSender("@me:hs", [" @me:hs "])).toBe(true);
    expect(isAllowedSender(" @me:hs ", ["@me:hs"])).toBe(true);
    expect(isAllowedSender("@someone:hs", ["@me:hs"])).toBe(false);
    expect(isAllowedSender("", ["@me:hs"])).toBe(false);
  });
});

describe("SeenEventIds", () => {
  test("dedupes by event id and evicts past the cap", () => {
    const seen = new SeenEventIds(2);
    expect(seen.has("$1")).toBe(false);
    seen.mark("$1");
    expect(seen.has("$1")).toBe(true);
    seen.mark("$2");
    seen.mark("$3"); // evicts $1
    expect(seen.has("$1")).toBe(false);
    expect(seen.has("$3")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm vitest run src/matrixInbound.test.ts`
Expected: FAIL — `Cannot find module './matrixInbound.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// agent/src/matrixInbound.ts
/**
 * Inbound Matrix: the operator texts the assistant over a Matrix room to diagnose
 * the cluster and approve queued fixes. This module is the pure, testable core —
 * parsing the client-server `/sync` payload, authenticating the sender against an
 * allowlist of Matrix IDs, routing a message to a command, de-duplicating by
 * `event_id`, and chunking replies. All IO (the actual sync/send HTTP, model
 * calls, executor) is injected via handlers, mirroring signalInbound.ts.
 *
 * Security model: only senders on the allowlist are ever acted on; everything
 * else is dropped silently. Free text is a READ-ONLY diagnosis question; the only
 * mutation path is `approve` of an already-vetted, queued suggestion.
 */
export interface MatrixEvent {
  /** Matrix event id — the natural de-dupe key. */
  eventId: string;
  /** Full Matrix user id of the sender, e.g. "@me:hs". */
  sender: string;
  /** The trimmed message body. */
  body: string;
  /** origin_server_ts (ms) — the clock for diagnosis threading. */
  timestamp: number;
}

export interface MatrixSyncResult {
  events: MatrixEvent[];
  /** The `next_batch` cursor to pass as `since` on the following poll. */
  nextBatch: string;
}

/**
 * Parse a `GET /_matrix/client/v3/sync` response: pull `next_batch` and the
 * timeline events for `roomId`. Keeps only `m.room.message` events with a
 * non-empty `m.text` body. Anything malformed is skipped rather than thrown.
 */
export function parseSyncEvents(raw: unknown, roomId: string): MatrixSyncResult {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const nextBatch = typeof root["next_batch"] === "string" ? (root["next_batch"] as string) : "";
  const out: MatrixEvent[] = [];
  const rooms = root["rooms"] && typeof root["rooms"] === "object" ? (root["rooms"] as Record<string, unknown>) : undefined;
  const join = rooms?.["join"] && typeof rooms["join"] === "object" ? (rooms["join"] as Record<string, unknown>) : undefined;
  const room = join?.[roomId] && typeof join[roomId] === "object" ? (join[roomId] as Record<string, unknown>) : undefined;
  const timeline = room?.["timeline"] && typeof room["timeline"] === "object" ? (room["timeline"] as Record<string, unknown>) : undefined;
  const events = Array.isArray(timeline?.["events"]) ? (timeline!["events"] as unknown[]) : [];
  for (const e of events) {
    const ev = e && typeof e === "object" ? (e as Record<string, unknown>) : null;
    if (!ev || ev["type"] !== "m.room.message") continue;
    const content = ev["content"] && typeof ev["content"] === "object" ? (ev["content"] as Record<string, unknown>) : undefined;
    if (!content || content["msgtype"] !== "m.text") continue;
    const body = typeof content["body"] === "string" ? (content["body"] as string).trim() : "";
    if (body === "") continue;
    const eventId = typeof ev["event_id"] === "string" ? (ev["event_id"] as string) : "";
    const sender = typeof ev["sender"] === "string" ? (ev["sender"] as string) : "";
    if (!eventId || !sender) continue;
    const timestamp = typeof ev["origin_server_ts"] === "number" ? (ev["origin_server_ts"] as number) : 0;
    out.push({ eventId, sender, body, timestamp });
  }
  return { events: out, nextBatch };
}

/** Is `sender` on the allowlist? Exact match on the trimmed Matrix id. */
export function isAllowedSender(sender: string, allow: string[]): boolean {
  const s = sender.trim();
  if (!s) return false;
  return allow.some((a) => a.trim() === s);
}

/** Bounded set of processed `event_id`s so a redelivered event is never answered
 *  twice. Oldest ids are evicted past the cap. Mirrors signalInbound's
 *  SeenTimestamps, keyed on the Matrix event id instead of (source, timestamp). */
export class SeenEventIds {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly cap = 500) {}
  has(id: string): boolean {
    return this.seen.has(id);
  }
  mark(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.cap) {
      const old = this.order.shift();
      if (old !== undefined) this.seen.delete(old);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm vitest run src/matrixInbound.test.ts`
Expected: PASS (3 + 1 + 1 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/src/matrixInbound.ts agent/src/matrixInbound.test.ts
git commit -m "feat(agent): pure Matrix /sync event parsing, allowlist + event-id de-dup"
```

---

### Task 2: Agent — extract `CommandHandlers` + `dispatchCommand` (reuse seam)

**Files:**
- Modify: `agent/src/signalInbound.ts:154-228` (the `InboundHandlers` interface + `handleInbound` dispatch switch)
- Test: `agent/src/signalInbound.test.ts` (add a `dispatchCommand` block; the existing `handleInbound` tests are the refactor's safety net)

- [ ] **Step 1: Write the failing test** (append to `agent/src/signalInbound.test.ts`)

```ts
import { dispatchCommand, type CommandHandlers } from "./signalInbound.js";

describe("dispatchCommand", () => {
  const handlers: CommandHandlers = {
    help: () => "HELP",
    status: async () => "STATUS",
    queue: async () => "QUEUE",
    approve: async (i: number) => `APPROVED ${i}`,
    diagnose: async (q: string, source: string, ts: number) => `DX ${q} ${source} ${ts}`,
  };

  test("routes each command kind and threads source/timestamp into diagnose", async () => {
    expect(await dispatchCommand({ kind: "help" }, handlers, "+1", 9)).toBe("HELP");
    expect(await dispatchCommand({ kind: "approve", index: 2 }, handlers, "+1", 9)).toBe("APPROVED 2");
    expect(await dispatchCommand({ kind: "diagnose", text: "why?" }, handlers, "@me:hs", 42)).toBe("DX why? @me:hs 42");
  });

  test("turns a handler throw into an error reply string", async () => {
    const boom: CommandHandlers = { ...handlers, status: async () => { throw new Error("down"); } };
    expect(await dispatchCommand({ kind: "status" }, boom, "+1", 0)).toContain("down");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm vitest run src/signalInbound.test.ts`
Expected: FAIL — `dispatchCommand`/`CommandHandlers` not exported.

- [ ] **Step 3: Write minimal implementation**

In `agent/src/signalInbound.ts`, replace the `InboundHandlers` interface (currently ~L163-172) with the split below:

```ts
/** The transport-agnostic command surface: the five things any inbound channel
 *  routes to. Shared verbatim by the Signal and Matrix inbound loops. */
export interface CommandHandlers {
  help(): string;
  status(): Promise<string>;
  queue(): Promise<string>;
  approve(index: number): Promise<string>;
  diagnose(question: string, source: string, timestamp: number): Promise<string>;
  log?(msg: string): void;
}

export interface InboundHandlers extends CommandHandlers {
  receive(apiUrl: string, number: string): Promise<unknown>;
  reply(recipient: string, text: string): Promise<void>;
}

/** Route a parsed command to the matching handler, turning a handler throw into
 *  an error reply string. `source`/`timestamp` thread into diagnosis (the
 *  channel's sender id + message time). Shared by Signal and Matrix inbound. */
export async function dispatchCommand(
  cmd: Command,
  h: CommandHandlers,
  source: string,
  timestamp: number,
): Promise<string> {
  try {
    switch (cmd.kind) {
      case "help":
        return h.help();
      case "status":
        return await h.status();
      case "queue":
        return await h.queue();
      case "approve":
        return await h.approve(cmd.index);
      case "diagnose":
        return await h.diagnose(cmd.text, source, timestamp);
    }
  } catch (e) {
    return `Sorry — that failed: ${String(e)}`;
  }
}
```

Then in `handleInbound` (currently ~L200-226), replace the per-command `switch` + try/catch with a `dispatchCommand` call so there is a single dispatcher:

```ts
    const cmd = parseCommand(msg.text);
    h.log?.(`signal: ${cmd.kind} from ${msg.source}`);
    const reply = await dispatchCommand(cmd, h, msg.source, msg.timestamp);
    for (const chunk of chunkText(reply)) {
      await h.reply(msg.source, chunk);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm vitest run src/signalInbound.test.ts`
Expected: PASS — the new `dispatchCommand` block AND every existing `handleInbound` test (the refactor preserves behavior).

- [ ] **Step 5: Commit**

```bash
git add agent/src/signalInbound.ts agent/src/signalInbound.test.ts
git commit -m "refactor(agent): extract CommandHandlers + dispatchCommand for transport reuse"
```

---

### Task 3: Agent — `handleMatrixInbound` orchestrator

**Files:**
- Modify: `agent/src/matrixInbound.ts` (add `MatrixInboundContext`, `MatrixInboundHandlers`, `handleMatrixInbound`)
- Test: `agent/src/matrixInbound.test.ts` (add the orchestration block)

- [ ] **Step 1: Write the failing test** (append to `agent/src/matrixInbound.test.ts`)

```ts
import { vi } from "vitest";
import { handleMatrixInbound, type MatrixInboundContext, type MatrixInboundHandlers } from "./matrixInbound.js";

function fakeHandlers(over: Partial<MatrixInboundHandlers> = {}): MatrixInboundHandlers & { replies: string[] } {
  const replies: string[] = [];
  return {
    replies,
    sync: vi.fn(async () => ({ next_batch: "s2", rooms: { join: {} } })),
    reply: vi.fn(async (text: string) => { replies.push(text); }),
    help: () => "HELP",
    status: vi.fn(async () => "STATUS"),
    queue: vi.fn(async () => "QUEUE"),
    approve: vi.fn(async (i: number) => `APPROVED ${i}`),
    diagnose: vi.fn(async (q: string) => `DIAGNOSED: ${q}`),
    ...over,
  };
}

const CTX: MatrixInboundContext = {
  enabled: true,
  homeserverUrl: "https://hs",
  accessToken: "tok",
  roomId: "!room:hs",
  allow: ["@me:hs"],
  since: "s1",
};

function syncWith(events: unknown[], nextBatch = "s2") {
  return { next_batch: nextBatch, rooms: { join: { "!room:hs": { timeline: { events } } } } };
}

describe("handleMatrixInbound", () => {
  test("returns the prior cursor and does nothing when disabled/unconfigured", async () => {
    const h = fakeHandlers();
    expect(await handleMatrixInbound({ ...CTX, enabled: false }, h, new SeenEventIds())).toBe("s1");
    expect(await handleMatrixInbound({ ...CTX, accessToken: undefined }, h, new SeenEventIds())).toBe("s1");
    expect(h.sync).not.toHaveBeenCalled();
  });

  test("routes a diagnosis question from an allowed sender and returns next_batch", async () => {
    const raw = syncWith([
      { type: "m.room.message", event_id: "$1", sender: "@me:hs", origin_server_ts: 5, content: { msgtype: "m.text", body: "why down?" } },
    ]);
    const h = fakeHandlers({ sync: vi.fn(async () => raw) });
    const next = await handleMatrixInbound(CTX, h, new SeenEventIds());
    expect(h.diagnose).toHaveBeenCalledWith("why down?", "@me:hs", 5);
    expect(h.replies).toEqual(["DIAGNOSED: why down?"]);
    expect(next).toBe("s2");
  });

  test("ignores messages from senders not on the allowlist", async () => {
    const raw = syncWith([
      { type: "m.room.message", event_id: "$1", sender: "@stranger:hs", origin_server_ts: 5, content: { msgtype: "m.text", body: "status" } },
    ]);
    const h = fakeHandlers({ sync: vi.fn(async () => raw) });
    await handleMatrixInbound(CTX, h, new SeenEventIds());
    expect(h.status).not.toHaveBeenCalled();
    expect(h.replies).toEqual([]);
  });

  test("does not re-process an event id already seen", async () => {
    const raw = syncWith([
      { type: "m.room.message", event_id: "$dup", sender: "@me:hs", origin_server_ts: 5, content: { msgtype: "m.text", body: "status" } },
    ]);
    const h = fakeHandlers({ sync: vi.fn(async () => raw) });
    const seen = new SeenEventIds();
    await handleMatrixInbound(CTX, h, seen);
    await handleMatrixInbound(CTX, h, seen);
    expect(h.status).toHaveBeenCalledTimes(1);
  });

  test("a sync failure is swallowed and keeps the prior cursor", async () => {
    const h = fakeHandlers({ sync: vi.fn(async () => { throw new Error("unreachable"); }) });
    expect(await handleMatrixInbound(CTX, h, new SeenEventIds())).toBe("s1");
    expect(h.replies).toEqual([]);
  });

  test("chunks a long reply into multiple sends", async () => {
    const raw = syncWith([
      { type: "m.room.message", event_id: "$1", sender: "@me:hs", origin_server_ts: 5, content: { msgtype: "m.text", body: "explain" } },
    ]);
    const h = fakeHandlers({ sync: vi.fn(async () => raw), diagnose: vi.fn(async () => "x".repeat(3000)) });
    await handleMatrixInbound(CTX, h, new SeenEventIds());
    expect(h.replies.length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm vitest run src/matrixInbound.test.ts`
Expected: FAIL — `handleMatrixInbound` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `agent/src/matrixInbound.ts`; add the import at the top of the file)

```ts
import { parseCommand, dispatchCommand, chunkText, type CommandHandlers } from "./signalInbound.js";
```

```ts
export interface MatrixInboundContext {
  /** Whether inbound command handling is turned on (assistant-config matrixInbound). */
  enabled: boolean;
  homeserverUrl?: string;
  accessToken?: string;
  roomId?: string;
  /** Authorized sender Matrix ids (the operator's own id by default). */
  allow: string[];
  /** The `since` cursor from the last poll (undefined on first run). */
  since?: string;
}

export interface MatrixInboundHandlers extends CommandHandlers {
  /** GET /_matrix/client/v3/sync with the stored cursor; returns the parsed body. */
  sync(since: string | undefined): Promise<unknown>;
  /** PUT a reply into the configured room. */
  reply(text: string): Promise<void>;
}

/**
 * One inbound poll: sync from the cursor, drop anything unauthorized or already
 * seen, route each event to its command, and reply (chunked). Never throws — a
 * handler failure becomes an error reply and a sync failure keeps the prior
 * cursor, so inbound never disturbs the remediation loop. Returns the new `since`
 * cursor for the caller to persist (the prior cursor on a failed/empty sync).
 */
export async function handleMatrixInbound(
  ctx: MatrixInboundContext,
  h: MatrixInboundHandlers,
  seen: SeenEventIds,
): Promise<string | undefined> {
  if (!ctx.enabled || !ctx.homeserverUrl || !ctx.accessToken || !ctx.roomId) return ctx.since;
  let raw: unknown;
  try {
    raw = await h.sync(ctx.since);
  } catch (e) {
    h.log?.(`matrix sync failed: ${String(e)}`);
    return ctx.since;
  }
  const { events, nextBatch } = parseSyncEvents(raw, ctx.roomId);
  for (const ev of events) {
    if (seen.has(ev.eventId)) continue;
    seen.mark(ev.eventId);
    if (!isAllowedSender(ev.sender, ctx.allow)) {
      h.log?.(`matrix: ignoring message from unauthorized sender ${ev.sender}`);
      continue;
    }
    const cmd = parseCommand(ev.body);
    h.log?.(`matrix: ${cmd.kind} from ${ev.sender}`);
    const reply = await dispatchCommand(cmd, h, ev.sender, ev.timestamp);
    for (const chunk of chunkText(reply)) {
      await h.reply(chunk);
    }
  }
  return nextBatch || ctx.since;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm vitest run src/matrixInbound.test.ts`
Expected: PASS (all blocks).

- [ ] **Step 5: Commit**

```bash
git add agent/src/matrixInbound.ts agent/src/matrixInbound.test.ts
git commit -m "feat(agent): handleMatrixInbound poll loop (sync, allowlist, dedupe, reply)"
```

---

### Task 4: Agent — `notifyMatrix` + `receiveMatrix` IO

**Files:**
- Modify: `agent/src/notify.ts` (add the two functions + a `chunkText` import)
- Test: `agent/src/notify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// agent/src/notify.test.ts
import { afterEach, describe, expect, test, vi } from "vitest";
import { notifyMatrix, receiveMatrix } from "./notify.js";

afterEach(() => vi.unstubAllGlobals());

describe("notifyMatrix", () => {
  test("PUTs an m.text message with a bearer token to the room send endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }));
    await notifyMatrix("https://hs.example/", "tok", "!room:hs", "hello");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("https://hs.example/_matrix/client/v3/rooms/");
    expect(calls[0].url).toContain("/send/m.room.message/");
    expect(calls[0].init.method).toBe("PUT");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ msgtype: "m.text", body: "hello" });
  });

  test("chunks a long message into multiple PUTs", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await notifyMatrix("https://hs", "tok", "!r", "x".repeat(3000));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  test("never throws when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(notifyMatrix("https://hs", "tok", "!r", "hi")).resolves.toBeUndefined();
  });
});

describe("receiveMatrix", () => {
  test("GETs /sync with the since cursor and returns the json", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ next_batch: "s2" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await receiveMatrix("https://hs/", "tok", "s1");
    expect(out).toEqual({ next_batch: "s2" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/_matrix/client/v3/sync?");
    expect(url).toContain("since=s1");
  });

  test("throws on a non-2xx sync so the caller logs and skips", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(receiveMatrix("https://hs", "tok")).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm vitest run src/notify.test.ts`
Expected: FAIL — `notifyMatrix`/`receiveMatrix` not exported.

- [ ] **Step 3: Write minimal implementation** (add to `agent/src/notify.ts`; add the import at the top)

```ts
import { chunkText } from "./signalInbound.js";
```

```ts
/**
 * Send a reply into a Matrix room via the client-server API
 * (`PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}`). One PUT
 * per chunk, each with a unique transaction id. Best-effort; never throws —
 * notification failure must not affect remediation.
 */
export async function notifyMatrix(
  homeserver: string,
  accessToken: string,
  roomId: string,
  text: string,
): Promise<void> {
  const base = homeserver.replace(/\/+$/, "");
  for (const chunk of chunkText(text)) {
    const txnId = `rigel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      await fetch(
        `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ msgtype: "m.text", body: chunk }),
        },
      );
    } catch {
      // swallow — notifications are best-effort
    }
  }
}

/**
 * Drain inbound events via `GET /_matrix/client/v3/sync` from the stored `since`
 * cursor (`timeout=0` for a non-blocking poll each tick). Returns the parsed JSON
 * (the caller decodes the room timeline). Throws on a transport or non-2xx error
 * so inbound handling can log and skip this poll.
 */
export async function receiveMatrix(
  homeserver: string,
  accessToken: string,
  since?: string,
): Promise<unknown> {
  const base = homeserver.replace(/\/+$/, "");
  const params = new URLSearchParams({ timeout: "0" });
  if (since) params.set("since", since);
  const res = await fetch(`${base}/_matrix/client/v3/sync?${params.toString()}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`matrix sync returned ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm vitest run src/notify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/src/notify.ts agent/src/notify.test.ts
git commit -m "feat(agent): notifyMatrix (chunked PUT send) + receiveMatrix (/sync poll)"
```

---

### Task 5: Agent — `parseMatrixConfig` + `RuntimeConfig.matrix`

**Files:**
- Modify: `agent/src/runtimeConfig.ts:31-48` (`RuntimeConfig`), `:125-133` (`disabledDefaults`), `:157-172` (`readRuntimeConfig`)
- Test: `agent/src/runtimeConfig.test.ts`

- [ ] **Step 1: Write the failing test** (append to `agent/src/runtimeConfig.test.ts`)

```ts
import { parseMatrixConfig } from "./runtimeConfig.js";

describe("parseMatrixConfig", () => {
  test("reads matrix keys from config and the access token from env", () => {
    const m = parseMatrixConfig(
      {
        matrixHomeserverUrl: " https://hs ",
        matrixUserId: "@rigel:hs",
        matrixRoomId: "!r:hs",
        matrixAllowedSenders: "@me:hs, @you:hs",
        matrixInbound: "true",
      },
      { MATRIX_ACCESS_TOKEN: " tok " } as NodeJS.ProcessEnv,
    );
    expect(m).toEqual({
      homeserverUrl: "https://hs",
      userId: "@rigel:hs",
      accessToken: "tok",
      roomId: "!r:hs",
      allowedSenders: ["@me:hs", "@you:hs"],
      inbound: true,
    });
  });

  test("defaults: no keys/env → undefineds, empty allowlist, inbound false", () => {
    expect(parseMatrixConfig({}, {} as NodeJS.ProcessEnv)).toEqual({
      homeserverUrl: undefined,
      userId: undefined,
      accessToken: undefined,
      roomId: undefined,
      allowedSenders: [],
      inbound: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm vitest run src/runtimeConfig.test.ts`
Expected: FAIL — `parseMatrixConfig` not exported.

- [ ] **Step 3: Write minimal implementation**

In `agent/src/runtimeConfig.ts`, add the type + parser (place near `parseRoleSelection`):

```ts
/** The Matrix channel config: connection + bot identity from the ConfigMap, plus
 *  the access token injected from a Secret as the MATRIX_ACCESS_TOKEN env var. */
export interface MatrixRuntime {
  homeserverUrl?: string;
  userId?: string;
  accessToken?: string;
  roomId?: string;
  allowedSenders: string[];
  inbound: boolean;
}

/** Parse the Matrix block: connection/identity/room/allowlist from the config
 *  data, the access token from `env.MATRIX_ACCESS_TOKEN` (it never lives in the
 *  ConfigMap). Pure. */
export function parseMatrixConfig(
  data: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): MatrixRuntime {
  const trimOrUndef = (v?: string) => (v && v.trim() ? v.trim() : undefined);
  const token = env.MATRIX_ACCESS_TOKEN;
  return {
    homeserverUrl: trimOrUndef(data["matrixHomeserverUrl"]),
    userId: trimOrUndef(data["matrixUserId"]),
    accessToken: token && token.trim() ? token.trim() : undefined,
    roomId: trimOrUndef(data["matrixRoomId"]),
    allowedSenders: (data["matrixAllowedSenders"] ?? "")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
    inbound: data["matrixInbound"] === "true",
  };
}
```

Add `matrix: MatrixRuntime;` to the `RuntimeConfig` interface (next to `signalInbound`). In `disabledDefaults`, add `matrix: parseMatrixConfig({}, {} as NodeJS.ProcessEnv),`. In `readRuntimeConfig`'s returned object, add `matrix: parseMatrixConfig(data, process.env),`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm vitest run src/runtimeConfig.test.ts`
Expected: PASS (new block + every existing runtimeConfig test).

- [ ] **Step 5: Commit**

```bash
git add agent/src/runtimeConfig.ts agent/src/runtimeConfig.test.ts
git commit -m "feat(agent): parseMatrixConfig + RuntimeConfig.matrix (token from env)"
```

---

### Task 6: Agent — wire Matrix into the tick (flush + inbound + cursor)

**Files:**
- Modify: `agent/src/state.ts:99-106` (`AssistantState`), `agent/src/index.ts` (imports, `LoopState`, `tick`, `flushNotifications`, `main`, plus `buildCommandHandlers` + `handleMatrixInboundIO`)

This is integration glue with no clean unit (mirrors `handleSignalInbound`, which has no unit test); the well-tested units are Tasks 1–5. The gate is typecheck + the full agent suite staying green.

- [ ] **Step 1: Add the cursor field to state**

In `agent/src/state.ts`, add to `AssistantState` (after `report: string;`):

```ts
  /** Matrix /sync cursor, persisted so a restart resumes without reprocessing or
   *  missing events. Absent until the first inbound poll. */
  matrixSince?: string;
```

- [ ] **Step 2: Extract the shared command handlers + add Matrix wiring in `index.ts`**

Update the `signalInbound` import to pull the shared type:

```ts
import {
  handleInbound,
  HELP_TEXT,
  SeenTimestamps,
  type CommandHandlers,
  type InboundHandlers,
} from "./signalInbound.js";
```

Add the Matrix imports:

```ts
import { notifyWebhook, notifySignal, receiveSignal, notifyMatrix, receiveMatrix } from "./notify.js";
import {
  handleMatrixInbound,
  SeenEventIds,
  type MatrixInboundHandlers,
} from "./matrixInbound.js";
```

Extend `LoopState`:

```ts
interface LoopState {
  streaks: Map<string, number>;
  handled: Set<string>;
  /** Inbound Signal messages already processed, so none is answered twice. */
  seen: SeenTimestamps;
  /** Inbound Matrix events already processed (de-dup by event_id). */
  seenMatrix: SeenEventIds;
  /** The persisted Matrix /sync cursor (loaded from state on first poll). */
  matrixSince?: string;
  /** Per-sender claude diagnosis threads (1-hour idle reset, in-memory). */
  sessions: SessionStore;
}
```

In `main()`, seed it: `const loop: LoopState = { streaks: new Map(), handled: new Set(), seen: new SeenTimestamps(), seenMatrix: new SeenEventIds(), sessions: new SessionStore() };`

Extend `flushNotifications` to fan out to Matrix (coexists with webhook + Signal; neither blocks the other):

```ts
function flushNotifications(rc: RuntimeConfig, notifications: string[]): void {
  if (notifications.length === 0) return;
  const text = `Rigel assistant:\n${notifications.join("\n")}`;
  if (rc.webhookUrl) void notifyWebhook(rc.webhookUrl, text);
  if (rc.signalApiUrl && rc.signalNumber) {
    void notifySignal(rc.signalApiUrl, rc.signalNumber, rc.signalRecipients, text);
  }
  if (rc.matrix.homeserverUrl && rc.matrix.accessToken && rc.matrix.roomId) {
    void notifyMatrix(rc.matrix.homeserverUrl, rc.matrix.accessToken, rc.matrix.roomId, text);
  }
}
```

Add the shared command-handler factory (extract the closures currently inline in `handleSignalInbound` so Signal and Matrix share one definition):

```ts
/** The transport-agnostic command handlers (help/status/queue/approve/diagnose),
 *  shared by the Signal and Matrix inbound loops. `approve` runs a queued,
 *  supervised fix through the same circuit breaker + backup path as the loop. */
function buildCommandHandlers(
  cfg: Config,
  rc: RuntimeConfig,
  cb: CircuitBreaker,
  loop: LoopState,
): CommandHandlers {
  return {
    help: () => HELP_TEXT,
    status: async () => {
      const s = await readState(cfg.stateConfigMap, cfg.stateNamespace);
      const enabled = s.status?.enabled ? "active" : "disabled";
      return `Rigel assistant is ${enabled}. ${s.queue.length} fix(es) queued. Updated ${s.updatedAt || "—"}.`;
    },
    queue: async () => {
      const s = await readState(cfg.stateConfigMap, cfg.stateNamespace);
      if (s.queue.length === 0) return "No fixes are queued.";
      const lines = s.queue
        .slice(0, 10)
        .map((q, i) => `${i + 1}. ${q.suggestion} — ${q.incident}${q.action ? "" : " (manual; run in Rigel)"}`);
      return `${lines.join("\n")}\n\nReply "approve N" to run one.`;
    },
    approve: (index) => approveQueued(cfg, cb, index),
    diagnose: (question, source, timestamp) =>
      runThreadedDiagnosis(
        { sessions: loop.sessions, diagnose: (q, resumeId) => runDiagnosis(rc, q, resumeId), log },
        source,
        timestamp,
        question,
      ),
    log,
  };
}
```

Refactor `handleSignalInbound` to spread the shared handlers (replace its inline `handlers` object body):

```ts
  const handlers: InboundHandlers = {
    receive: (apiUrl, number) => receiveSignal(apiUrl, number),
    reply: (to, text) => notifySignal(rc.signalApiUrl!, rc.signalNumber!, [to], text),
    ...buildCommandHandlers(cfg, rc, cb, loop),
  };
  await handleInbound({ enabled: true, apiUrl: rc.signalApiUrl, number: rc.signalNumber, allow }, handlers, loop.seen);
```

Add the Matrix inbound IO wiring:

```ts
/** Wire the real IO handlers and run one Matrix inbound poll. Allowlist: explicit
 *  allowed senders, else fall back to the bot's own id. Persists the /sync cursor
 *  to assistant-state so a restart resumes cleanly. */
async function handleMatrixInboundIO(
  cfg: Config,
  rc: RuntimeConfig,
  cb: CircuitBreaker,
  loop: LoopState,
): Promise<void> {
  const m = rc.matrix;
  const allow = m.allowedSenders.length > 0 ? m.allowedSenders : m.userId ? [m.userId] : [];
  if (allow.length === 0) {
    log("matrix inbound: no authorized senders configured — skipping");
    return;
  }
  if (loop.matrixSince === undefined) {
    const s = await readState(cfg.stateConfigMap, cfg.stateNamespace);
    loop.matrixSince = s.matrixSince;
  }
  const handlers: MatrixInboundHandlers = {
    sync: (since) => receiveMatrix(m.homeserverUrl!, m.accessToken!, since),
    reply: (text) => notifyMatrix(m.homeserverUrl!, m.accessToken!, m.roomId!, text),
    ...buildCommandHandlers(cfg, rc, cb, loop),
  };
  const next = await handleMatrixInbound(
    { enabled: true, homeserverUrl: m.homeserverUrl, accessToken: m.accessToken, roomId: m.roomId, allow, since: loop.matrixSince },
    handlers,
    loop.seenMatrix,
  );
  if (next !== loop.matrixSince) {
    loop.matrixSince = next;
    const s = await readState(cfg.stateConfigMap, cfg.stateNamespace);
    await writeState(cfg.stateConfigMap, cfg.stateNamespace, { ...s, matrixSince: next });
  }
}
```

Call it in `tick`, right after the existing Signal inbound block:

```ts
  // Two-way Matrix: independent of Signal — runs if enabled, never blocks it.
  if (rc.matrix.inbound && rc.matrix.homeserverUrl && rc.matrix.accessToken && rc.matrix.roomId) {
    try {
      await handleMatrixInboundIO(cfg, rc, cb, loop);
    } catch (e) {
      log(`matrix inbound error: ${String(e)}`);
    }
  }
```

- [ ] **Step 3: Typecheck**

Run: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm typecheck`
Expected: PASS (no type errors).

- [ ] **Step 4: Run the full agent suite**

Run: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm vitest run`
Expected: PASS — every existing + new test green (Signal handlers refactored through `buildCommandHandlers` with no behavior change).

- [ ] **Step 5: Commit**

```bash
git add agent/src/index.ts agent/src/state.ts
git commit -m "feat(agent): coexisting Matrix outbound + inbound in the tick, persisted /sync cursor"
```

---

### Task 7: k8s — Matrix config/secret/status helpers

**Files:**
- Create: `packages/k8s/src/matrix.ts`
- Modify: `packages/k8s/src/index.ts` (re-export `./matrix`)
- Test: `packages/k8s/src/matrix.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/k8s/src/matrix.test.ts
import { test, expect } from "vitest";
import {
  MATRIX_SECRET_NAME,
  matrixSecretYAML,
  matrixConfigUpdates,
  matrixHomeserverUrl,
  matrixUserId,
  matrixRoomId,
  matrixAllowedSenders,
  matrixInbound,
  parseAllowedSenders,
  deriveMatrixConnected,
  matrixStatusColor,
  matrixStatusLabel,
} from "./matrix";

test("matrixSecretYAML builds the token Secret with name/key, escaping quotes", () => {
  const yaml = matrixSecretYAML('to"k', "agents");
  expect(yaml).toContain(`name: ${MATRIX_SECRET_NAME}`);
  expect(yaml).toContain("namespace: agents");
  expect(yaml).toContain('accessToken: "to\\"k"');
});

test("matrixSecretYAML defaults an empty namespace to default", () => {
  expect(matrixSecretYAML("t", "  ")).toContain("namespace: default");
});

test("matrixConfigUpdates includes only provided fields, inbound as a string", () => {
  expect(matrixConfigUpdates({ homeserverUrl: "https://hs", inbound: true })).toEqual({
    matrixHomeserverUrl: "https://hs",
    matrixInbound: "true",
  });
  expect(matrixConfigUpdates({ allowedSenders: "" })).toEqual({ matrixAllowedSenders: "" });
  expect(matrixConfigUpdates({})).toEqual({});
});

test("config readers pull the matrix keys", () => {
  const d = { matrixHomeserverUrl: "https://hs", matrixUserId: "@r:hs", matrixRoomId: "!x:hs", matrixAllowedSenders: "@a:hs", matrixInbound: "true" };
  expect(matrixHomeserverUrl(d)).toBe("https://hs");
  expect(matrixUserId(d)).toBe("@r:hs");
  expect(matrixRoomId(d)).toBe("!x:hs");
  expect(matrixAllowedSenders(d)).toBe("@a:hs");
  expect(matrixInbound(d)).toBe(true);
  expect(matrixInbound({})).toBe(false);
});

test("parseAllowedSenders splits on comma/newline and trims", () => {
  expect(parseAllowedSenders("@a:hs, @b:hs\n@c:hs ,")).toEqual(["@a:hs", "@b:hs", "@c:hs"]);
  expect(parseAllowedSenders("   ")).toEqual([]);
});

test("deriveMatrixConnected requires homeserver + user + room", () => {
  expect(deriveMatrixConnected({})).toBe(false);
  expect(deriveMatrixConnected({ matrixHomeserverUrl: "https://hs", matrixUserId: "@r:hs" })).toBe(false);
  expect(deriveMatrixConnected({ matrixHomeserverUrl: "https://hs", matrixUserId: "@r:hs", matrixRoomId: "!x:hs" })).toBe(true);
});

test("status color + label map the four states", () => {
  expect(matrixStatusColor("notConnected")).toBe("gray");
  expect(matrixStatusColor("connecting")).toBe("amber");
  expect(matrixStatusColor("connected")).toBe("green");
  expect(matrixStatusColor("error")).toBe("red");
  expect(matrixStatusLabel("connected")).toBe("Connected");
  expect(matrixStatusLabel("notConnected")).toMatch(/not connected/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test src/matrix.test.ts`
Expected: FAIL — `Cannot find module './matrix'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/k8s/src/matrix.ts
// Matrix channel — shared pure helpers (mirrors signal.ts). The byte-identical
// source of truth for the access-token Secret, the assistant-config Matrix keys,
// the config readers, and the connection status the web panel derives. No kubectl
// runs here — these are pure functions the web panel and the server both call.

/** Secret holding the bot access token, injected into the agent as
 *  MATRIX_ACCESS_TOKEN (see packages/k8s assistant deployment()). */
export const MATRIX_SECRET_NAME = "rigel-matrix-token";
/** Data key inside MATRIX_SECRET_NAME. */
export const MATRIX_ACCESS_TOKEN_KEY = "accessToken";

/** YAML-escape a token for a double-quoted stringData value. */
function escapeYaml(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The Secret YAML for the bot access token. Applied via `kubectl apply -f -`;
 *  never previewed (carries the token). */
export function matrixSecretYAML(token: string, namespace = "default"): string {
  const ns = namespace.trim() || "default";
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${MATRIX_SECRET_NAME}
  namespace: ${ns}
  labels:
    app.kubernetes.io/managed-by: rigel-assistant
type: Opaque
stringData:
  ${MATRIX_ACCESS_TOKEN_KEY}: "${escapeYaml(token)}"`;
}

/** Build the `data` patch for a setMatrix write. Only provided fields are
 *  included so the server's read-modify-write never clobbers unrelated keys. The
 *  access token is NOT here — it lives in the Secret. */
export function matrixConfigUpdates(args: {
  homeserverUrl?: string;
  userId?: string;
  roomId?: string;
  allowedSenders?: string;
  inbound?: boolean;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (args.homeserverUrl !== undefined) out["matrixHomeserverUrl"] = args.homeserverUrl;
  if (args.userId !== undefined) out["matrixUserId"] = args.userId;
  if (args.roomId !== undefined) out["matrixRoomId"] = args.roomId;
  if (args.allowedSenders !== undefined) out["matrixAllowedSenders"] = args.allowedSenders;
  if (args.inbound !== undefined) out["matrixInbound"] = args.inbound ? "true" : "false";
  return out;
}

export function matrixHomeserverUrl(d: Record<string, string>): string {
  return d["matrixHomeserverUrl"] ?? "";
}
export function matrixUserId(d: Record<string, string>): string {
  return d["matrixUserId"] ?? "";
}
export function matrixRoomId(d: Record<string, string>): string {
  return d["matrixRoomId"] ?? "";
}
export function matrixAllowedSenders(d: Record<string, string>): string {
  return d["matrixAllowedSenders"] ?? "";
}
export function matrixInbound(d: Record<string, string>): boolean {
  return d["matrixInbound"] === "true";
}

/** Parse a comma/newline-separated allowed-senders string into a trimmed list. */
export function parseAllowedSenders(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Connected once a homeserver, bot id, and room are all saved. */
export function deriveMatrixConnected(d: Record<string, string>): boolean {
  return (
    matrixHomeserverUrl(d).trim() !== "" &&
    matrixUserId(d).trim() !== "" &&
    matrixRoomId(d).trim() !== ""
  );
}

/** UI status: connected/notConnected derive from config; connecting/error are
 *  transient wizard states owned by the component. */
export type MatrixStatus = "notConnected" | "connecting" | "connected" | "error";

export function matrixStatusColor(s: MatrixStatus): "gray" | "amber" | "green" | "red" {
  switch (s) {
    case "notConnected":
      return "gray";
    case "connecting":
      return "amber";
    case "connected":
      return "green";
    case "error":
      return "red";
  }
}

export function matrixStatusLabel(s: MatrixStatus): string {
  switch (s) {
    case "notConnected":
      return "Not connected";
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected";
    case "error":
      return "Connection error";
  }
}
```

Add to `packages/k8s/src/index.ts` (after the signal export block ~L152):

```ts
export {
  type MatrixStatus,
  MATRIX_SECRET_NAME,
  MATRIX_ACCESS_TOKEN_KEY,
  matrixSecretYAML,
  matrixConfigUpdates,
  matrixHomeserverUrl,
  matrixUserId,
  matrixRoomId,
  matrixAllowedSenders,
  matrixInbound,
  parseAllowedSenders,
  deriveMatrixConnected,
  matrixStatusColor,
  matrixStatusLabel,
} from "./matrix";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test src/matrix.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/matrix.ts packages/k8s/src/matrix.test.ts packages/k8s/src/index.ts
git commit -m "feat(k8s): Matrix secret/config/status helpers (mirrors signal.ts)"
```

---

### Task 8: k8s — inject `MATRIX_ACCESS_TOKEN` into the agent Deployment

**Files:**
- Modify: `packages/k8s/src/assistant.ts:695-719` (the `deployment()` env list)
- Test: `packages/k8s/src/assistant.test.ts`

- [ ] **Step 1: Write the failing test** (append to `packages/k8s/src/assistant.test.ts`)

```ts
import { manifestYAML, DEFAULT_INSTALL_CONFIG } from "./assistant";

test("the agent Deployment injects the Matrix access token from its Secret, optional", () => {
  const yaml = manifestYAML(DEFAULT_INSTALL_CONFIG);
  expect(yaml).toContain("- name: MATRIX_ACCESS_TOKEN");
  expect(yaml).toContain("name: rigel-matrix-token");
  expect(yaml).toContain("key: accessToken");
  // optional: true so installs without Matrix configured still start.
  expect(yaml).toMatch(/MATRIX_ACCESS_TOKEN[\s\S]*?optional: true/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/k8s test src/assistant.test.ts`
Expected: FAIL — the env var is not in the manifest.

- [ ] **Step 3: Write minimal implementation**

In `packages/k8s/src/assistant.ts` `deployment()`, add the env block immediately after the `STATE_NAMESPACE` env entry (before the container `securityContext`):

```ts
            # Matrix bot access token (optional) — written by the Matrix connect
            # wizard into the rigel-matrix-token Secret. optional:true so installs
            # without Matrix configured start fine; the agent reads it from env.
            - name: MATRIX_ACCESS_TOKEN
              valueFrom:
                secretKeyRef:
                  name: rigel-matrix-token
                  key: accessToken
                  optional: true
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rigel/k8s test src/assistant.test.ts`
Expected: PASS (new test + every existing assistant manifest test).

- [ ] **Step 5: Commit**

```bash
git add packages/k8s/src/assistant.ts packages/k8s/src/assistant.test.ts
git commit -m "feat(k8s): inject MATRIX_ACCESS_TOKEN env into the agent Deployment (optional)"
```

---

### Task 9: Server — `/api/matrix` proxy (login / validate / createRoom)

**Files:**
- Create: `apps/server/src/matrix.ts`
- Modify: `apps/server/src/index.ts` (add the `POST /api/matrix` route + import)
- Test: `apps/server/src/matrix.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/src/matrix.test.ts
import { test, expect, describe } from "vitest";
import {
  normalizeHomeserver,
  loginRequest,
  whoamiRequest,
  createRoomRequest,
  handleMatrix,
} from "./matrix";

test("normalizeHomeserver trims whitespace and trailing slashes", () => {
  expect(normalizeHomeserver("  https://hs.example/  ")).toBe("https://hs.example");
  expect(normalizeHomeserver("https://hs.example///")).toBe("https://hs.example");
});

test("loginRequest targets v3/login with an m.login.password body", () => {
  const { url, body } = loginRequest("https://hs", "rigel", "pw");
  expect(url).toBe("https://hs/_matrix/client/v3/login");
  expect(body).toEqual({ type: "m.login.password", identifier: { type: "m.id.user", user: "rigel" }, password: "pw" });
});

test("whoamiRequest targets v3 whoami with a bearer header", () => {
  const { url, headers } = whoamiRequest("https://hs/", "tok");
  expect(url).toBe("https://hs/_matrix/client/v3/account/whoami");
  expect(headers.authorization).toBe("Bearer tok");
});

test("createRoomRequest creates an UNENCRYPTED private room with invites", () => {
  const { url, headers, body } = createRoomRequest("https://hs", "tok", { name: "Rigel", invite: ["@me:hs"] });
  expect(url).toBe("https://hs/_matrix/client/v3/createRoom");
  expect(headers.authorization).toBe("Bearer tok");
  expect(body).toEqual({ preset: "private_chat", name: "Rigel", invite: ["@me:hs"], is_direct: false });
  // Never request encryption — the room must stay unencrypted.
  expect(JSON.stringify(body)).not.toContain("m.room.encryption");
});

describe("handleMatrix guards (short-circuit before any network call)", () => {
  test("login requires homeserver + user + password", async () => {
    expect((await handleMatrix({ action: "login", user: "r", password: "p" })).status).toBe(422);
    expect((await handleMatrix({ action: "login", homeserver: "https://hs", password: "p" })).status).toBe(422);
    expect((await handleMatrix({ action: "login", homeserver: "https://hs", user: "r" })).status).toBe(422);
  });

  test("validate requires homeserver + accessToken", async () => {
    expect((await handleMatrix({ action: "validate", homeserver: "https://hs" })).status).toBe(422);
    expect((await handleMatrix({ action: "validate", accessToken: "t" })).status).toBe(422);
  });

  test("createRoom requires homeserver + accessToken", async () => {
    expect((await handleMatrix({ action: "createRoom", homeserver: "https://hs" })).status).toBe(422);
  });

  test("an unknown action is a 422 error", async () => {
    // @ts-expect-error — exercising the default branch
    expect((await handleMatrix({ action: "bogus" })).status).toBe(422);
  });
});
```

(The guard tests reference `.status`, which only exists on an `{ kind: "error" }` result; since the guards return errors, this typechecks via the union narrowing below — assert on `res` after a `kind` check if your TS config is strict.) If strict narrowing complains, wrap each as:

```ts
const r = await handleMatrix({ action: "login", user: "r", password: "p" });
expect(r.kind).toBe("error");
if (r.kind === "error") expect(r.status).toBe(422);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/server test src/matrix.test.ts`
Expected: FAIL — `Cannot find module './matrix'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/server/src/matrix.ts
// Matrix connect proxy — server side of the connect wizard (mirrors signal.ts).
//
// POST /api/matrix dispatches on `action`:
//   login     → POST /_matrix/client/v3/login (m.login.password), returns
//               { accessToken, userId }; the password is used once and discarded.
//   validate  → GET  /_matrix/client/v3/account/whoami, returns { userId } (a
//               reachability + token check).
//   createRoom→ POST /_matrix/client/v3/createRoom, creates an UNENCRYPTED room
//               and invites the allowed senders, returns { roomId }.
//
// All calls are outbound HTTP to the user's homeserver (no kubectl). Never
// throws — failures return an { kind: "error" } so the route picks the status.

export type MatrixAction = "login" | "validate" | "createRoom";

export interface MatrixRequest {
  action: MatrixAction;
  homeserver?: string;
  user?: string;
  password?: string;
  accessToken?: string;
  roomName?: string;
  invite?: string[];
}

export type MatrixResult =
  | { kind: "json"; body: unknown }
  | { kind: "error"; status: number; message: string };

/** Trim and drop trailing slashes from a homeserver base URL. */
export function normalizeHomeserver(raw: string): string {
  return (raw ?? "").trim().replace(/\/+$/, "");
}

export function loginRequest(homeserver: string, user: string, password: string): { url: string; body: unknown } {
  return {
    url: `${normalizeHomeserver(homeserver)}/_matrix/client/v3/login`,
    body: { type: "m.login.password", identifier: { type: "m.id.user", user }, password },
  };
}

export function whoamiRequest(homeserver: string, accessToken: string): { url: string; headers: Record<string, string> } {
  return {
    url: `${normalizeHomeserver(homeserver)}/_matrix/client/v3/account/whoami`,
    headers: { authorization: `Bearer ${accessToken}` },
  };
}

export function createRoomRequest(
  homeserver: string,
  accessToken: string,
  opts: { name: string; invite: string[] },
): { url: string; headers: Record<string, string>; body: unknown } {
  return {
    url: `${normalizeHomeserver(homeserver)}/_matrix/client/v3/createRoom`,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    // No m.room.encryption initial_state → an UNENCRYPTED room. Element X refuses
    // to create these, so Rigel (the bot) provisions it. Privacy comes from
    // server ownership, not E2E (see the design doc).
    body: { preset: "private_chat", name: opts.name, invite: opts.invite, is_direct: false },
  };
}

/** Route a parsed Matrix request. Never throws — see the module header. */
export async function handleMatrix(req: MatrixRequest): Promise<MatrixResult> {
  try {
    switch (req.action) {
      case "login": {
        const homeserver = normalizeHomeserver(req.homeserver ?? "");
        const user = (req.user ?? "").trim();
        const password = req.password ?? "";
        if (homeserver === "") return { kind: "error", status: 422, message: "Enter your homeserver URL." };
        if (user === "" || password === "") return { kind: "error", status: 422, message: "Enter the bot username and password." };
        const { url, body } = loginRequest(homeserver, user, password);
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) {
          const status = res.status === 401 || res.status === 403 ? 401 : 502;
          return { kind: "error", status, message: `Login failed: ${(await res.text().catch(() => "")).trim() || `HTTP ${res.status}`}` };
        }
        const data = (await res.json()) as { access_token?: string; user_id?: string };
        if (!data.access_token) return { kind: "error", status: 502, message: "Login succeeded but no access token was returned." };
        return { kind: "json", body: { accessToken: data.access_token, userId: data.user_id ?? "" } };
      }
      case "validate": {
        const homeserver = normalizeHomeserver(req.homeserver ?? "");
        const accessToken = (req.accessToken ?? "").trim();
        if (homeserver === "") return { kind: "error", status: 422, message: "Enter your homeserver URL." };
        if (accessToken === "") return { kind: "error", status: 422, message: "Paste the bot access token." };
        const { url, headers } = whoamiRequest(homeserver, accessToken);
        const res = await fetch(url, { headers });
        if (!res.ok) {
          const status = res.status === 401 ? 401 : 502;
          return { kind: "error", status, message: `Token check failed: HTTP ${res.status}` };
        }
        const data = (await res.json()) as { user_id?: string };
        return { kind: "json", body: { userId: data.user_id ?? "" } };
      }
      case "createRoom": {
        const homeserver = normalizeHomeserver(req.homeserver ?? "");
        const accessToken = (req.accessToken ?? "").trim();
        if (homeserver === "") return { kind: "error", status: 422, message: "Enter your homeserver URL." };
        if (accessToken === "") return { kind: "error", status: 422, message: "Connect the bot account first." };
        const { url, headers, body } = createRoomRequest(homeserver, accessToken, {
          name: req.roomName?.trim() || "Rigel",
          invite: req.invite ?? [],
        });
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        if (!res.ok) {
          return { kind: "error", status: 502, message: `Could not create the room: ${(await res.text().catch(() => "")).trim() || `HTTP ${res.status}`}` };
        }
        const data = (await res.json()) as { room_id?: string };
        if (!data.room_id) return { kind: "error", status: 502, message: "Room created but no room id was returned." };
        return { kind: "json", body: { roomId: data.room_id } };
      }
      default:
        return { kind: "error", status: 422, message: `unknown action: ${String((req as { action?: string }).action)}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", status: 502, message: `Could not reach the homeserver: ${message}` };
  }
}
```

Add the route to `apps/server/src/index.ts` (import alongside the signal import ~L57, route after the `/api/signal` block ~L982):

```ts
import { handleMatrix, type MatrixRequest } from "./matrix";
```

```ts
    // POST /api/matrix — Matrix connect proxy for the desktop wizard. Outbound
    // HTTP to the user's homeserver only (no kubectl). Dispatches on `action`:
    //   login → { accessToken, userId } | validate → { userId } | createRoom → { roomId }
    if (url.pathname === "/api/matrix" && req.method === "POST") {
      let body: MatrixRequest;
      try {
        body = (await req.json()) as MatrixRequest;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (typeof body.action !== "string") {
        return Response.json({ error: "missing action" }, { status: 422 });
      }
      const result = await handleMatrix(body);
      if (result.kind === "error") {
        return Response.json({ error: result.message }, { status: result.status });
      }
      return Response.json(result.body);
    }
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @rigel/server test src/matrix.test.ts && pnpm --filter @rigel/server typecheck`
Expected: PASS (tests green, route typechecks).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/matrix.ts apps/server/src/matrix.test.ts apps/server/src/index.ts
git commit -m "feat(server): /api/matrix proxy — login/validate/createRoom (unencrypted)"
```

---

### Task 10: Server — `setMatrix` assistant action

**Files:**
- Modify: `apps/server/src/assistant.ts` (request fields, `AssistantAction` union, `setMatrixUpdates`/`setMatrixSecret`, `setMatrix`, dispatch, imports)
- Test: `apps/server/src/assistant.test.ts`

- [ ] **Step 1: Write the failing test** (append to `apps/server/src/assistant.test.ts`)

```ts
import { setMatrixUpdates, setMatrixSecret } from "./assistant";

test("setMatrixUpdates maps only the provided matrix fields", () => {
  expect(
    setMatrixUpdates({
      action: "setMatrix",
      matrixHomeserverUrl: "https://hs",
      matrixUserId: "@rigel:hs",
      matrixRoomId: "!r:hs",
      matrixAllowedSenders: "@me:hs",
      matrixInbound: true,
    }),
  ).toEqual({
    matrixHomeserverUrl: "https://hs",
    matrixUserId: "@rigel:hs",
    matrixRoomId: "!r:hs",
    matrixAllowedSenders: "@me:hs",
    matrixInbound: "true",
  });
  // An inbound-only toggle never clobbers the other keys.
  expect(setMatrixUpdates({ action: "setMatrix", matrixInbound: false })).toEqual({ matrixInbound: "false" });
});

test("setMatrixSecret returns the token Secret YAML only when a token is supplied", () => {
  const yaml = setMatrixSecret({ action: "setMatrix", matrixAccessToken: "tok" }, "agents");
  expect(yaml).not.toBeNull();
  expect(yaml).toContain("name: rigel-matrix-token");
  expect(yaml).toContain('accessToken: "tok"');
  expect(setMatrixSecret({ action: "setMatrix" }, "agents")).toBeNull();
  expect(setMatrixSecret({ action: "setMatrix", matrixAccessToken: "   " }, "agents")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rigel/server test src/assistant.test.ts`
Expected: FAIL — `setMatrixUpdates`/`setMatrixSecret` not exported.

- [ ] **Step 3: Write minimal implementation**

In `apps/server/src/assistant.ts`:

Add the import next to the signal import (~L43):

```ts
import { signalConfigUpdates } from "@rigel/k8s/src/signal";
import { matrixConfigUpdates, matrixSecretYAML } from "@rigel/k8s/src/matrix";
```

Add `"setMatrix"` to the `AssistantAction` union (next to `"setSignal"`).

Add the request fields to `AssistantRequest` (after the setSignal fields):

```ts
  // setMatrix — Matrix channel config. The token goes to a Secret (env-injected),
  // the rest into assistant-config (read live each tick).
  matrixHomeserverUrl?: string;
  matrixUserId?: string;
  matrixAccessToken?: string;
  matrixRoomId?: string;
  matrixAllowedSenders?: string;
  matrixInbound?: boolean;
```

Add the pure helpers (next to `setLimitsUpdates`):

```ts
/** Pure: the assistant-config matrix-key updates for a setMatrix request. */
export function setMatrixUpdates(req: AssistantRequest): Record<string, string> {
  return matrixConfigUpdates({
    homeserverUrl: req.matrixHomeserverUrl,
    userId: req.matrixUserId,
    roomId: req.matrixRoomId,
    allowedSenders: req.matrixAllowedSenders,
    inbound: req.matrixInbound,
  });
}

/** Pure: the Matrix token Secret YAML for a setMatrix request, or null when no
 *  token is supplied (a config-only edit). */
export function setMatrixSecret(req: AssistantRequest, namespace: string): string | null {
  const token = (req.matrixAccessToken ?? "").trim();
  return token === "" ? null : matrixSecretYAML(token, namespace);
}
```

Add the IO handler (next to `setSignal`):

```ts
/**
 * Read-modify-write `assistant-config` with the Matrix settings (only provided
 * fields) and, when a token is supplied, write the access-token Secret. A new/
 * changed token reaches the agent via the injected MATRIX_ACCESS_TOKEN env, so a
 * token write rolls the agent; a config-only edit is read live each tick (no
 * restart). Mirrors setSignal + the credential-Secret restart pattern.
 */
async function setMatrix(
  context: string | null,
  namespace: string,
  req: AssistantRequest,
): Promise<RunResult> {
  const tokenYaml = setMatrixSecret(req, namespace);
  if (tokenYaml) {
    ensureOk(await applyStdin(context, tokenYaml), "Failed to write the Matrix token Secret");
  }
  const updates = setMatrixUpdates(req);
  let last: RunResult = { code: 0, stdout: "", stderr: "" };
  if (Object.keys(updates).length > 0) {
    last = await patchConfig(context, namespace, updates);
  }
  if (tokenYaml) return restartAgent(context, namespace);
  return last;
}
```

Add the dispatch case (next to `case "setSignal":`):

```ts
    case "setMatrix":
      return setMatrix(context, namespace, req);
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @rigel/server test src/assistant.test.ts && pnpm --filter @rigel/server typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/assistant.ts apps/server/src/assistant.test.ts
git commit -m "feat(server): setMatrix action (config + token Secret + roll on token change)"
```

---

### Task 11: Web — `api.ts` Matrix types + connect helpers

**Files:**
- Modify: `apps/web/src/lib/api.ts` (`AssistantAction` union, `AssistantRequest` fields, three Matrix helpers)
- Test: `apps/web/src/lib/api.matrix.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/api.matrix.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { matrixLogin, matrixValidate, matrixCreateRoom } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("matrix api helpers", () => {
  it("matrixLogin posts credentials and returns the result", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accessToken: "tok", userId: "@rigel:hs" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await matrixLogin("https://hs", "rigel", "pw");
    expect(r).toEqual({ accessToken: "tok", userId: "@rigel:hs" });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/matrix");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ action: "login", homeserver: "https://hs", user: "rigel", password: "pw" });
  });

  it("matrixValidate posts the token and returns the user id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ userId: "@rigel:hs" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await matrixValidate("https://hs", "tok");
    expect(r).toEqual({ userId: "@rigel:hs" });
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ action: "validate", homeserver: "https://hs", accessToken: "tok" });
  });

  it("matrixCreateRoom posts invites and returns the room id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ roomId: "!r:hs" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await matrixCreateRoom("https://hs", "tok", "Rigel", ["@me:hs"]);
    expect(r).toEqual({ roomId: "!r:hs" });
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ action: "createRoom", homeserver: "https://hs", accessToken: "tok", roomName: "Rigel", invite: ["@me:hs"] });
  });

  it("throws the server error message on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 400 })));
    await expect(matrixLogin("https://hs", "r", "p")).rejects.toThrow(/boom/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test src/lib/api.matrix.test.ts`
Expected: FAIL — `matrixLogin`/`matrixValidate`/`matrixCreateRoom` not exported.

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/lib/api.ts`:

Add `| "setMatrix"` to the `AssistantAction` union (next to `"setSignal"`).

Add to `AssistantRequest` (after the setSignal fields):

```ts
  // setMatrix — Matrix channel config (token → Secret; rest → assistant-config).
  matrixHomeserverUrl?: string;
  matrixUserId?: string;
  matrixAccessToken?: string;
  matrixRoomId?: string;
  matrixAllowedSenders?: string;
  matrixInbound?: boolean;
```

Add the helpers (after the Signal helpers ~L656; `throwApiError` already exists in this file):

```ts
// ---------------------------------------------------------------------------
// Matrix connect proxy — POST /api/matrix
// ---------------------------------------------------------------------------

export interface MatrixLoginResult {
  accessToken: string;
  userId: string;
}

/** Log the bot in (username + password) and return a token + the resolved id. */
export async function matrixLogin(homeserver: string, user: string, password: string): Promise<MatrixLoginResult> {
  const res = await fetch("/api/matrix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "login", homeserver, user, password }),
  });
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as MatrixLoginResult;
}

/** Validate a pasted access token against the homeserver (whoami); returns the id. */
export async function matrixValidate(homeserver: string, accessToken: string): Promise<{ userId: string }> {
  const res = await fetch("/api/matrix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "validate", homeserver, accessToken }),
  });
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as { userId: string };
}

/** Provision an unencrypted room and invite the allowed senders; returns its id. */
export async function matrixCreateRoom(
  homeserver: string,
  accessToken: string,
  roomName: string,
  invite: string[],
): Promise<{ roomId: string }> {
  const res = await fetch("/api/matrix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "createRoom", homeserver, accessToken, roomName, invite }),
  });
  if (!res.ok) await throwApiError(res);
  return (await res.json()) as { roomId: string };
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter web test src/lib/api.matrix.test.ts && pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/api.matrix.test.ts
git commit -m "feat(web): matrix api helpers (login/validate/createRoom) + setMatrix types"
```

---

### Task 12: Web — Matrix derivation in `useSettings`

**Files:**
- Modify: `apps/web/src/panels/settings/useSettings.ts:79-141` (`SettingsDerived` + the derived object)
- Test: `apps/web/src/panels/settings/settings.test.ts`

- [ ] **Step 1: Write the failing test** (append to `apps/web/src/panels/settings/settings.test.ts`)

```ts
import { deriveMatrixConnected, matrixConfigUpdates, parseAllowedSenders } from "@rigel/k8s";

describe("shared matrix logic reachable via the web alias", () => {
  it("derives connected only when homeserver + user + room are all set", () => {
    expect(deriveMatrixConnected({})).toBe(false);
    expect(deriveMatrixConnected({ matrixHomeserverUrl: "https://hs", matrixUserId: "@r:hs" })).toBe(false);
    expect(deriveMatrixConnected({ matrixHomeserverUrl: "https://hs", matrixUserId: "@r:hs", matrixRoomId: "!x:hs" })).toBe(true);
  });

  it("builds config updates from only provided fields", () => {
    expect(matrixConfigUpdates({ roomId: "!x:hs", inbound: false })).toEqual({ matrixRoomId: "!x:hs", matrixInbound: "false" });
  });

  it("parses allowed senders on comma/newline", () => {
    expect(parseAllowedSenders("@a:h, @b:h")).toEqual(["@a:h", "@b:h"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test src/panels/settings/settings.test.ts`
Expected: FAIL — these `@rigel/k8s` exports are unresolved until the web package re-builds against Task 7. (If the monorepo resolves `@rigel/k8s` from source, this passes immediately; in that case treat Step 2 as the red guard for the `useSettings` additions below and proceed.)

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/panels/settings/useSettings.ts`, extend the imports:

```ts
import {
  deriveSignalBridgeStatus,
  hasSavedNumber as deriveHasSavedNumber,
  signalNumber as deriveSignalNumber,
  signalRecipients as deriveRecipients,
  signalInbound as deriveInbound,
  deriveMatrixConnected,
  matrixHomeserverUrl as deriveMatrixHomeserver,
  matrixUserId as deriveMatrixUserId,
  matrixRoomId as deriveMatrixRoomId,
  matrixAllowedSenders as deriveMatrixAllowed,
  matrixInbound as deriveMatrixInbound,
  type SignalBridgeStatus,
  type MatrixStatus,
} from "@rigel/k8s";
```

Add to `SettingsDerived`:

```ts
  /** Matrix channel: connected when homeserver+user+room are saved. */
  matrixStatus: MatrixStatus;
  matrixHomeserverUrl: string;
  matrixUserId: string;
  matrixRoomId: string;
  matrixAllowedSenders: string;
  matrixInbound: boolean;
```

Add to the returned object (inside the `useMemo`, alongside the signal fields — `config` is already in scope):

```ts
      matrixStatus: deriveMatrixConnected(config) ? "connected" : "notConnected",
      matrixHomeserverUrl: deriveMatrixHomeserver(config),
      matrixUserId: deriveMatrixUserId(config),
      matrixRoomId: deriveMatrixRoomId(config),
      matrixAllowedSenders: deriveMatrixAllowed(config),
      matrixInbound: deriveMatrixInbound(config),
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter web test src/panels/settings/settings.test.ts && pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/settings/useSettings.ts apps/web/src/panels/settings/settings.test.ts
git commit -m "feat(web): derive Matrix status + config fields in useSettings"
```

---

### Task 13: Web — `MatrixSection` (resting states + Enabled toggle)

**Files:**
- Create: `apps/web/src/panels/settings/MatrixSection.tsx`
- Modify: `apps/web/src/panels/settings/SettingsPanel.tsx` (render `<MatrixSection>`)
- Test: `apps/web/src/panels/settings/MatrixSection.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SettingsDerived } from "./useSettings";

const mutateAsync = vi.fn(async () => ({ success: true as const, stdout: "", stderr: "" }));
vi.mock("@/lib/api", () => ({ useAssistantAction: () => ({ mutateAsync, isPending: false }) }));

import { MatrixSection } from "./MatrixSection";

function derived(over: Partial<SettingsDerived> = {}): SettingsDerived {
  return {
    namespace: "default",
    status: "notDeployed",
    signalNumber: "", recipients: "", inbound: false, hasSavedNumber: false,
    matrixStatus: "notConnected", matrixHomeserverUrl: "", matrixUserId: "",
    matrixRoomId: "", matrixAllowedSenders: "", matrixInbound: false,
    ...over,
  } as SettingsDerived;
}

beforeEach(() => mutateAsync.mockClear());

describe("MatrixSection", () => {
  it("shows a Connect call to action when not connected", () => {
    render(<MatrixSection derived={derived()} />);
    expect(screen.getByRole("button", { name: /connect matrix/i })).toBeInTheDocument();
  });

  it("shows the connected summary (bot id + allowed senders)", () => {
    render(<MatrixSection derived={derived({ matrixStatus: "connected", matrixHomeserverUrl: "https://hs", matrixUserId: "@rigel:hs", matrixRoomId: "!r:hs", matrixAllowedSenders: "@me:hs", matrixInbound: true })} />);
    expect(screen.getByText(/@rigel:hs/)).toBeInTheDocument();
    expect(screen.getByText(/@me:hs/)).toBeInTheDocument();
  });

  it("toggles two-way inbound via setMatrix", async () => {
    render(<MatrixSection derived={derived({ matrixStatus: "connected", matrixHomeserverUrl: "https://hs", matrixUserId: "@rigel:hs", matrixRoomId: "!r:hs", matrixInbound: false })} />);
    fireEvent.click(screen.getByRole("button", { name: /text the assistant/i }));
    expect(mutateAsync).toHaveBeenCalledWith({ action: "setMatrix", namespace: "default", matrixInbound: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test src/panels/settings/MatrixSection.test.tsx`
Expected: FAIL — `Cannot find module './MatrixSection'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// apps/web/src/panels/settings/MatrixSection.tsx
// Matrix channel — a second chat channel alongside Signal. Resting states mirror
// SignalSection's state machine (not connected / connected / error). The connect
// wizard lives in MatrixConnectModal (paths A and B).
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { matrixStatusColor, matrixStatusLabel, parseAllowedSenders } from "@rigel/k8s";
import { useAssistantAction } from "@/lib/api";
import type { SettingsDerived } from "./useSettings";
import { MatrixConnectModal } from "./MatrixConnectModal";

const DOT_CLASS: Record<string, string> = {
  gray: "bg-muted-foreground/50",
  amber: "bg-amber-500",
  green: "bg-green-500",
  red: "bg-destructive",
};

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border bg-card p-3">{children}</div>;
}

export function MatrixSection({ derived }: { derived: SettingsDerived }) {
  const { namespace, matrixStatus, matrixHomeserverUrl, matrixUserId, matrixRoomId, matrixAllowedSenders, matrixInbound } = derived;
  const setMatrix = useAssistantAction();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dot = DOT_CLASS[matrixStatusColor(matrixStatus)];
  const label = matrixStatusLabel(matrixStatus);
  const senders = parseAllowedSenders(matrixAllowedSenders);

  async function toggleInbound() {
    setError(null);
    try {
      await setMatrix.mutateAsync({ action: "setMatrix", namespace, matrixInbound: !matrixInbound });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Matrix</h2>
        <span className="font-mono text-[10px] text-muted-foreground">ns: {namespace}</span>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} />
        <span className="font-mono text-xs">{label}</span>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="select-text">{error}</span>
        </div>
      )}

      {matrixStatus !== "connected" ? (
        <Button size="sm" onClick={() => setWizardOpen(true)}>
          Connect Matrix
        </Button>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1 text-xs">
            <div className="font-mono">Connected as {matrixUserId}</div>
            <div className="text-muted-foreground">Homeserver: {matrixHomeserverUrl}</div>
            <div className="text-muted-foreground">Room: {matrixRoomId}</div>
            <div className="text-muted-foreground">
              Allowed senders: {senders.length > 0 ? senders.join(", ") : "(bot only)"}
            </div>
          </div>

          <button
            className="flex items-center gap-2 text-left"
            onClick={toggleInbound}
            disabled={setMatrix.isPending}
          >
            <span
              className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                matrixInbound ? "bg-green-500" : "bg-muted-foreground/40"
              }`}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                  matrixInbound ? "translate-x-3.5" : "translate-x-0.5"
                }`}
              />
            </span>
            <span className="text-xs">Let me text the assistant back (two-way)</span>
          </button>

          <Button size="sm" variant="outline" onClick={() => setWizardOpen(true)}>
            Reconnect
          </Button>
        </div>
      )}

      <MatrixConnectModal
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        namespace={namespace}
        defaultAllowed={matrixAllowedSenders}
      />
    </Card>
  );
}
```

In `apps/web/src/panels/settings/SettingsPanel.tsx`, import and render it after `<SignalSection>`:

```tsx
import { MatrixSection } from "./MatrixSection";
```

```tsx
      <SignalSection derived={derived} applying={applying} setApplying={setApplying} />
      <MatrixSection derived={derived} />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test src/panels/settings/MatrixSection.test.tsx`
Expected: PASS (this exercises `MatrixSection`; `MatrixConnectModal` is built in Task 14 — create a minimal stub first if running this task in isolation, then complete it next).

> If executing strictly task-by-task, add a one-line stub `export function MatrixConnectModal() { return null; }` in `apps/web/src/panels/settings/MatrixConnectModal.tsx` so this task compiles; Task 14 replaces it with the real component (and its test).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/settings/MatrixSection.tsx apps/web/src/panels/settings/MatrixSection.test.tsx apps/web/src/panels/settings/SettingsPanel.tsx apps/web/src/panels/settings/MatrixConnectModal.tsx
git commit -m "feat(web): MatrixSection resting states + two-way toggle"
```

---

### Task 14: Web — `MatrixConnectModal` wizard (paths A/B, token-vs-login, first contact)

**Files:**
- Modify: `apps/web/src/panels/settings/MatrixConnectModal.tsx` (replace the stub with the real wizard)
- Test: `apps/web/src/panels/settings/MatrixConnectModal.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const matrixLogin = vi.fn(async () => ({ accessToken: "tok-login", userId: "@rigel:hs" }));
const matrixValidate = vi.fn(async () => ({ userId: "@rigel:hs" }));
const matrixCreateRoom = vi.fn(async () => ({ roomId: "!room:hs" }));
const mutateAsync = vi.fn(async () => ({ success: true as const, stdout: "", stderr: "" }));
vi.mock("@/lib/api", () => ({
  matrixLogin: (...a: unknown[]) => matrixLogin(...(a as [])),
  matrixValidate: (...a: unknown[]) => matrixValidate(...(a as [])),
  matrixCreateRoom: (...a: unknown[]) => matrixCreateRoom(...(a as [])),
  useAssistantAction: () => ({ mutateAsync, isPending: false }),
}));

import { MatrixConnectModal } from "./MatrixConnectModal";

beforeEach(() => {
  matrixLogin.mockClear();
  matrixValidate.mockClear();
  matrixCreateRoom.mockClear();
  mutateAsync.mockClear();
});

function open() {
  render(<MatrixConnectModal open onClose={() => {}} namespace="default" defaultAllowed="@me:hs" />);
}

describe("MatrixConnectModal", () => {
  it("path A + login: logs in, creates a room, saves via setMatrix", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /already have a homeserver/i }));
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "https://hs" } });
    fireEvent.click(screen.getByRole("button", { name: /^log in$/i })); // switch to login mode
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "rigel" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => expect(matrixLogin).toHaveBeenCalledWith("https://hs", "rigel", "pw"));
    expect(matrixValidate).not.toHaveBeenCalled();
    await waitFor(() => expect(matrixCreateRoom).toHaveBeenCalledWith("https://hs", "tok-login", "Rigel", ["@me:hs"]));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        action: "setMatrix",
        namespace: "default",
        matrixHomeserverUrl: "https://hs",
        matrixUserId: "@rigel:hs",
        matrixAccessToken: "tok-login",
        matrixRoomId: "!room:hs",
        matrixAllowedSenders: "@me:hs",
        matrixInbound: true,
      }),
    );
  });

  it("path A + token: validates the pasted token instead of logging in", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /already have a homeserver/i }));
    fireEvent.change(screen.getByLabelText(/homeserver/i), { target: { value: "https://hs" } });
    // token mode is the default
    fireEvent.change(screen.getByLabelText(/access token/i), { target: { value: "tok-paste" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => expect(matrixValidate).toHaveBeenCalledWith("https://hs", "tok-paste"));
    expect(matrixLogin).not.toHaveBeenCalled();
    await waitFor(() => expect(matrixCreateRoom).toHaveBeenCalledWith("https://hs", "tok-paste", "Rigel", ["@me:hs"]));
  });

  it("path B prefills matrix.org and shows the privacy caveat", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /public homeserver/i }));
    expect((screen.getByLabelText(/homeserver/i) as HTMLInputElement).value).toBe("https://matrix.org");
    expect(screen.getByText(/can read/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test src/panels/settings/MatrixConnectModal.test.tsx`
Expected: FAIL — the stub renders `null`, so no controls are found.

- [ ] **Step 3: Write minimal implementation** (replace the stub)

```tsx
// apps/web/src/panels/settings/MatrixConnectModal.tsx
// Matrix connect wizard. Path 1 picks where the homeserver lives:
//   A) an existing homeserver (the happy default for self-hosters)
//   B) a public homeserver (matrix.org) — honest privacy caveat
// Step 2 takes the homeserver URL + bot auth (paste a token OR log in) +
// allowed senders, then provisions an unencrypted room and saves via setMatrix.
// The terminal "first contact" step tells the user to accept the room invite.
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { parseAllowedSenders } from "@rigel/k8s";
import { matrixLogin, matrixValidate, matrixCreateRoom, useAssistantAction } from "@/lib/api";

type Path = "A" | "B";
type AuthMode = "token" | "login";
type Step = "path" | "details" | "firstContact";

export function MatrixConnectModal({
  open,
  onClose,
  namespace,
  defaultAllowed,
}: {
  open: boolean;
  onClose: () => void;
  namespace: string;
  defaultAllowed?: string;
}) {
  const setMatrix = useAssistantAction();
  const [step, setStep] = useState<Step>("path");
  const [path, setPath] = useState<Path | null>(null);
  const [homeserver, setHomeserver] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("token");
  const [token, setToken] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [allowed, setAllowed] = useState(defaultAllowed ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep("path");
    setPath(null);
    setHomeserver("");
    setAuthMode("token");
    setToken("");
    setUser("");
    setPassword("");
    setError(null);
    setBusy(false);
  }

  function choosePath(p: Path) {
    setPath(p);
    setHomeserver(p === "B" ? "https://matrix.org" : "");
    setStep("details");
  }

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      let accessToken: string;
      let userId: string;
      if (authMode === "login") {
        const r = await matrixLogin(homeserver, user, password);
        accessToken = r.accessToken;
        userId = r.userId;
      } else {
        accessToken = token.trim();
        const r = await matrixValidate(homeserver, accessToken);
        userId = r.userId;
      }
      const senders = parseAllowedSenders(allowed);
      const { roomId } = await matrixCreateRoom(homeserver, accessToken, "Rigel", senders);
      await setMatrix.mutateAsync({
        action: "setMatrix",
        namespace,
        matrixHomeserverUrl: homeserver,
        matrixUserId: userId,
        matrixAccessToken: accessToken,
        matrixRoomId: roomId,
        matrixAllowedSenders: senders.join(", "),
        matrixInbound: true,
      });
      setStep("firstContact");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    onClose();
    reset();
  }

  return (
    <Modal open={open} onOpenChange={(o) => (o ? undefined : close())} title="Connect Matrix">
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="select-text">{error}</span>
        </div>
      )}

      {step === "path" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Where should Rigel's Matrix live?</p>
          <Button size="sm" className="w-full justify-start" onClick={() => choosePath("A")}>
            I already have a homeserver
          </Button>
          <Button size="sm" variant="outline" className="w-full justify-start" onClick={() => choosePath("B")}>
            Use a public homeserver (matrix.org)
          </Button>
        </div>
      )}

      {step === "details" && (
        <div className="space-y-3">
          {path === "B" && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              The room is unencrypted, so the public host can read it. Use a homeserver you own for full privacy.
            </p>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Homeserver URL</span>
            <input
              aria-label="Homeserver URL"
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              placeholder="https://matrix.example.com"
              value={homeserver}
              onChange={(e) => setHomeserver(e.target.value)}
            />
          </label>

          <div className="inline-flex rounded-md border p-0.5 text-xs">
            <button
              className={`rounded px-2 py-0.5 ${authMode === "token" ? "bg-muted font-medium" : "text-muted-foreground"}`}
              onClick={() => setAuthMode("token")}
            >
              Paste a token
            </button>
            <button
              className={`rounded px-2 py-0.5 ${authMode === "login" ? "bg-muted font-medium" : "text-muted-foreground"}`}
              onClick={() => setAuthMode("login")}
            >
              Log in
            </button>
          </div>

          {authMode === "token" ? (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Bot access token</span>
              <input
                aria-label="Access token"
                className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          ) : (
            <div className="space-y-2">
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Bot username</span>
                <input
                  aria-label="Username"
                  className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Bot password</span>
                <input
                  aria-label="Password"
                  type="password"
                  className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </div>
          )}

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Allowed senders (comma-separated Matrix IDs)</span>
            <input
              aria-label="Allowed senders"
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              placeholder="@you:example.com"
              value={allowed}
              onChange={(e) => setAllowed(e.target.value)}
            />
          </label>

          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setStep("path")} disabled={busy}>
              Back
            </Button>
            <Button size="sm" onClick={connect} disabled={busy}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </div>
      )}

      {step === "firstContact" && (
        <div className="space-y-3">
          <p className="text-sm">Rigel created a room and invited you.</p>
          <p className="text-xs text-muted-foreground">
            Open your Matrix client, accept the invite, and say hi. Rigel will reply from the cluster.
          </p>
          <Button size="sm" onClick={close}>
            Done
          </Button>
        </div>
      )}
    </Modal>
  );
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter web test src/panels/settings/MatrixConnectModal.test.tsx && pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/panels/settings/MatrixConnectModal.tsx apps/web/src/panels/settings/MatrixConnectModal.test.tsx
git commit -m "feat(web): Matrix connect wizard (paths A/B, token-vs-login, first contact)"
```

---

## Final verification (run once, after Task 14)

- [ ] Agent: `cd /Users/tyrelchambers/home/claude-k8s/agent && pnpm typecheck && pnpm vitest run` — all green.
- [ ] k8s: `pnpm --filter @rigel/k8s test` — all green.
- [ ] Server: `pnpm --filter @rigel/server typecheck && pnpm --filter @rigel/server test` — all green.
- [ ] Web: `pnpm --filter web typecheck && pnpm --filter web test` — all green.
- [ ] Manual end-to-end (no automated coverage — no live homeserver in CI): against the author's homeserver with `@rigel` reserved, run the wizard (path A, paste a token), confirm Rigel provisions a room and invites you, accept it in a Matrix client, text `status` and `help`, and confirm replies arrive. Then confirm Signal still works simultaneously (both channels enabled).

---

## Coverage notes / spec gaps deferred to Phase 2

These are explicitly out of Phase 1 scope (Phase 2 "Install + expose"), per the spec's Phasing section — not omissions:

- In-cluster Synapse install (Deployment/Service/storage, account creation via registration shared secret, reserving `@rigel`).
- Tailscale-operator detection and the two exposure modes (Tailscale ingress vs public Ingress + cert-manager), and the `install`/`reachable` wizard screens (frames `KWBf1`, `sNhKw`).
- Path C in the wizard ("Install it in my cluster") and the dynamic 4-step stepper for installs (Phase 1 ships the 3-step bring-your-own paths A/B; the modal renders a fixed sequence, not yet a step counter).
- E2E-encrypted rooms on the agent side (documented future enhancement).

Phase-1 design decisions worth flagging for the coverage self-review:

- **Room provisioning lives server-side, not in the agent.** The spec lists "the agent provisions the room" under the Agent section, but Phase 1 implements `createRoom` in `apps/server/src/matrix.ts` (the wizard, acting as the bot with the same token, creates it during connect and writes the roomId via `setMatrix`). The agent and `apps/server` are separate packages with no shared code path, so this matches how Signal already splits agent vs server IO. Agent-driven re-provisioning/re-invite is not needed for Phase 1.
- **The "live Waiting → Received → Replied" first-contact animation** (frame `tXkqG`) is simplified to a static "room created, accept the invite" terminal step. The live round-trip indicator is a visual nicety deferred with the Pencil polish; the functional path (provision + invite + agent polls) is complete.
- **The token reaches the agent via `MATRIX_ACCESS_TOKEN` env (Secret-injected), mirroring `CLAUDE_CODE_OAUTH_TOKEN`.** Signal has no secret token, so this is the closest existing pattern. `setMatrix` rolls the agent only when a token is written (config-only edits are read live each tick).
