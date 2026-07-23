# Per-room durable Matrix bot sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the in-cluster Assistant Matrix bot hold one independent, durable `claude` conversation thread per room — spin up a topic by inviting the bot to a room; each room keeps its own session and context across idle time and pod restarts.

**Architecture:** Two changes cooperate. (1) The `agent/` runtime goes multi-room: it parses every joined room from `/sync`, auto-joins rooms it's invited to by an allowlisted user, threads each room's `claude` session by `roomId`, and persists the `roomId → sessionId` map to the state ConfigMap. (2) The rendered agent Deployment gains a PVC mounted at the CLI's `HOME`, so the transcript files that session ids point to survive restarts. Signal inbound is untouched (still threads by sender, in-memory, 1-hour idle reset). Synapse is untouched.

**Tech Stack:** TypeScript (Node), vitest. `agent/` is a standalone pnpm package (not in the workspace globs) — run its tests with `pnpm -C agent ...`. Deployment YAML is rendered as a string in `packages/k8s/src/assistant.ts` (workspace package — run with `pnpm --filter @rigel/k8s ...` or via repo root).

**Key design decisions (locked during brainstorming):**
- **Two `SessionStore` instances**, not one. Signal keeps its existing store (1-hour TTL, phone-number normalization). Matrix gets a second store with **no TTL** (durable) and **opaque keys** (room ids contain dots/colons and must not be normalized). This is why `SessionStore` gains an injectable `normalizeKey` and a configurable TTL rather than having its normalization removed outright — it preserves Signal byte-for-byte.
- **`roomId` still serves outbound broadcast** (morning reports, alerts via `notifyMatrix`). Only the *inbound* loop goes multi-room. Do not delete `matrix.roomId`.
- **Persistence rides the existing cursor write.** Every processed inbound event (a turn or a `/reset`) advances the `/sync` `next_batch` cursor, so the existing `if (next !== loop.matrixSince)` write already fires on activity. We fold `threadSessions` into that same `writeState`, adding no new write frequency and no per-record IO race.
- The Deployment already renders `replicas: 1` + `strategy: Recreate` (`packages/k8s/src/assistant.ts:760-762`), so the RWO-PVC single-writer requirement is already satisfied — we only add the PVC + mount + `HOME`.

---

## File structure

- `agent/src/sessionStore.ts` — MODIFY. Injectable `normalizeKey`, configurable TTL (Infinity = durable), `snapshot()` / `load()` for persistence. One responsibility: in-memory key→session pointer map.
- `agent/src/sessionStore.test.ts` — MODIFY. Cover opaque keys, no-TTL, snapshot/load; keep the Signal-normalization case via an explicitly-constructed store.
- `agent/src/signalInbound.ts` — MODIFY. `MessageHandler.respond` gains an optional `threadKey`; `respondSafely` passes it through. `handleInbound` unchanged (no `threadKey` → threads by sender).
- `agent/src/matrixInbound.ts` — MODIFY. `MatrixEvent` gains `roomId`; new `MatrixInvite`; `parseSyncEvents` walks all joined rooms + invites; handlers take `roomId`; auto-join allowlisted invites; `/reset`; pass `roomId` as `threadKey`.
- `agent/src/matrixInbound.test.ts` — MODIFY. Multi-room parse, invite gating, per-room targeting, `/reset`, `threadKey` passthrough.
- `agent/src/state.ts` — MODIFY. Add `threadSessions?: Record<string, string>` to `AssistantState`.
- `agent/src/notify.ts` — MODIFY. Add `joinMatrixRoom`.
- `agent/src/index.ts` — MODIFY. Second `SessionStore` (`roomSessions`); hydrate/persist `threadSessions`; relax the inbound gate; wire per-room handlers + `join` + `resetThread`; `buildMessageHandler` takes the store to use.
- `packages/k8s/src/assistant.ts` — MODIFY. Deployment gains `HOME` + volumeMount + volume; new `pvc()`; `manifestYAML` includes the PVC.
- `packages/k8s/src/assistant.test.ts` — MODIFY. Assert PVC rendered, `HOME` set, volume wired.

---

## Task 1: SessionStore — opaque keys, durable option, snapshot/load

**Files:**
- Modify: `agent/src/sessionStore.ts`
- Test: `agent/src/sessionStore.test.ts`

- [ ] **Step 1: Rewrite the tests**

Replace the entire contents of `agent/src/sessionStore.test.ts` with:

```ts
import { describe, expect, test } from "vitest";
import { SessionStore, ONE_HOUR_MS } from "./sessionStore.js";
import { normalizeNumber } from "./signalInbound.js";

const ME = "+15550101234";

describe("SessionStore (signal: TTL + number normalization)", () => {
  const signalStore = () => new SessionStore(ONE_HOUR_MS, normalizeNumber);

  test("returns undefined before any session is recorded", () => {
    expect(signalStore().resumeIdFor(ME, 1000)).toBeUndefined();
  });

  test("resumes within the hour", () => {
    const s = signalStore();
    s.record(ME, "sess-1", 0);
    expect(s.resumeIdFor(ME, ONE_HOUR_MS)).toBe("sess-1");
  });

  test("expires and evicts past the hour", () => {
    const s = signalStore();
    s.record(ME, "sess-1", 0);
    expect(s.resumeIdFor(ME, ONE_HOUR_MS + 1)).toBeUndefined();
    expect(s.resumeIdFor(ME, ONE_HOUR_MS + 2)).toBeUndefined();
  });

  test("record extends the idle window", () => {
    const s = signalStore();
    s.record(ME, "sess-1", 0);
    s.record(ME, "sess-1", ONE_HOUR_MS);
    expect(s.resumeIdFor(ME, ONE_HOUR_MS + ONE_HOUR_MS)).toBe("sess-1");
  });

  test("isolates senders and normalizes formatting", () => {
    const s = signalStore();
    s.record(ME, "sess-1", 0);
    expect(s.resumeIdFor("+1 (555) 010-1234", 1)).toBe("sess-1");
    expect(s.resumeIdFor("+15559999999", 1)).toBeUndefined();
  });

  test("clear drops the pointer", () => {
    const s = signalStore();
    s.record(ME, "sess-1", 0);
    s.clear(ME);
    expect(s.resumeIdFor(ME, 1)).toBeUndefined();
  });

  test("ignores an empty session id", () => {
    const s = signalStore();
    s.record(ME, "", 0);
    expect(s.resumeIdFor(ME, 1)).toBeUndefined();
  });
});

describe("SessionStore (matrix: durable, opaque keys)", () => {
  const ROOM = "!AbCd:matrix.tail8a13da.ts.net";
  const durable = () => new SessionStore(Number.POSITIVE_INFINITY);

  test("keeps opaque room-id keys verbatim (no normalization mangling dots/colons)", () => {
    const s = durable();
    s.record(ROOM, "sess-room", 0);
    expect(s.resumeIdFor(ROOM, 1)).toBe("sess-room");
    // A key that would collide under number-normalization stays distinct.
    expect(s.resumeIdFor("!AbCdmatrixtail8a13datsnet", 1)).toBeUndefined();
  });

  test("never expires with an infinite TTL", () => {
    const s = durable();
    s.record(ROOM, "sess-room", 0);
    expect(s.resumeIdFor(ROOM, ONE_HOUR_MS * 24 * 365)).toBe("sess-room");
  });

  test("snapshot returns key -> sessionId for every live entry", () => {
    const s = durable();
    s.record("!a:hs", "s-a", 0);
    s.record("!b:hs", "s-b", 0);
    expect(s.snapshot()).toEqual({ "!a:hs": "s-a", "!b:hs": "s-b" });
  });

  test("load hydrates a snapshot so resume works after a restart", () => {
    const s = durable();
    s.load({ "!a:hs": "s-a" }, 0);
    expect(s.resumeIdFor("!a:hs", 1)).toBe("s-a");
  });

  test("load ignores undefined and empty ids", () => {
    const s = durable();
    s.load(undefined, 0);
    s.load({ "!a:hs": "" }, 0);
    expect(s.snapshot()).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C agent exec vitest run src/sessionStore.test.ts`
Expected: FAIL — `new SessionStore(ONE_HOUR_MS, normalizeNumber)` rejects a 2nd arg / `snapshot`/`load` don't exist.

- [ ] **Step 3: Rewrite `sessionStore.ts`**

Replace the entire contents of `agent/src/sessionStore.ts` with:

```ts
/**
 * A key → `claude` CLI session pointer, used to thread a conversation. Two
 * instances exist: the Signal store (1-hour idle TTL, phone-number-normalized
 * keys, in-memory) and the Matrix store (no expiry, opaque room-id keys,
 * persisted to the state ConfigMap so a topic room survives pod restarts).
 * `normalizeKey` and `ttlMs` are injected so one class serves both. Pure and
 * clock-free: "now" is always passed in.
 */
export const ONE_HOUR_MS = 3_600_000;

interface Entry {
  sessionId: string;
  lastActivityMs: number;
}

export class SessionStore {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly ttlMs = ONE_HOUR_MS,
    private readonly normalizeKey: (s: string) => string = (s) => s,
  ) {}

  /** The session to resume for `key` if its last activity was within the TTL;
   * otherwise evict the stale entry and return undefined (→ start fresh). With
   * an infinite TTL nothing is ever evicted. */
  resumeIdFor(key: string, nowMs: number): string | undefined {
    const k = this.normalizeKey(key);
    const e = this.entries.get(k);
    if (!e) return undefined;
    if (nowMs - e.lastActivityMs > this.ttlMs) {
      this.entries.delete(k);
      return undefined;
    }
    return e.sessionId;
  }

  /** Remember `sessionId` as `key`'s active thread, stamped at `nowMs`. A blank
   * id is ignored so we never resume a non-existent session. */
  record(key: string, sessionId: string, nowMs: number): void {
    if (!sessionId) return;
    this.entries.set(this.normalizeKey(key), { sessionId, lastActivityMs: nowMs });
  }

  /** Forget `key`'s thread (used on `/reset` and when a resume fails). */
  clear(key: string): void {
    this.entries.delete(this.normalizeKey(key));
  }

  /** A `key → sessionId` snapshot for persistence to the state ConfigMap. */
  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, e] of this.entries) out[k] = e.sessionId;
    return out;
  }

  /** Rehydrate from a persisted snapshot, stamping each entry as active at
   * `nowMs`. Blank ids and a missing snapshot are ignored. */
  load(snapshot: Record<string, string> | undefined, nowMs: number): void {
    if (!snapshot) return;
    for (const [k, id] of Object.entries(snapshot)) {
      if (id) this.entries.set(k, { sessionId: id, lastActivityMs: nowMs });
    }
  }
}
```

Note: this removes the previous `import { normalizeNumber }` and the built-in normalization — the Signal store now injects `normalizeNumber` explicitly (wired in Task 7).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C agent exec vitest run src/sessionStore.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add agent/src/sessionStore.ts agent/src/sessionStore.test.ts
git commit -m "feat(agent): SessionStore injectable key-normalization, durable TTL, snapshot/load"
```

---

## Task 2: MessageHandler gains an optional threadKey

**Files:**
- Modify: `agent/src/signalInbound.ts` (interface `MessageHandler`, function `respondSafely`)

This is a small, type-level seam. `handleInbound` (Signal) keeps calling `respondSafely` with no `threadKey`, so Signal continues to thread by sender. Matrix will pass `roomId` (Task 3).

- [ ] **Step 1: Add `threadKey` to the `MessageHandler` contract**

In `agent/src/signalInbound.ts`, replace the `respond` signature in the `MessageHandler` interface:

```ts
  respond(text: string, source: string, timestamp: number): Promise<string>;
```

with:

```ts
  /** Handle one inbound message: investigate, make reversible changes, run a
   *  confirmed destructive action through the guard, return the reply text.
   *  Threading is keyed by `threadKey` when given (Matrix passes the room id),
   *  else by `source` (Signal threads by sender). */
  respond(text: string, source: string, timestamp: number, threadKey?: string): Promise<string>;
```

- [ ] **Step 2: Pass `threadKey` through `respondSafely`**

Replace the whole `respondSafely` function with:

```ts
/** Run one message through the agent, turning a throw into an error reply. */
export async function respondSafely(
  h: MessageHandler,
  text: string,
  source: string,
  timestamp: number,
  threadKey?: string,
): Promise<string> {
  try {
    return await h.respond(text, source, timestamp, threadKey);
  } catch (e) {
    return `Sorry — that failed: ${String(e)}`;
  }
}
```

Leave `handleInbound` as-is: its `respondSafely(h, msg.text, msg.source, msg.timestamp)` call passes no `threadKey`, so Signal is unchanged.

- [ ] **Step 3: Verify the package still type-checks**

Run: `pnpm -C agent exec tsc --noEmit`
Expected: PASS (no type errors). `matrixInbound.ts` still compiles because the new param is optional.

- [ ] **Step 4: Run the existing signal tests**

Run: `pnpm -C agent exec vitest run src/signalInbound.test.ts`
Expected: PASS (behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add agent/src/signalInbound.ts
git commit -m "feat(agent): MessageHandler.respond accepts an optional threadKey"
```

---

## Task 3: Multi-room Matrix inbound (parse, invites, per-room handlers, /reset)

**Files:**
- Modify: `agent/src/matrixInbound.ts`
- Test: `agent/src/matrixInbound.test.ts`

- [ ] **Step 1: Rewrite the tests**

Replace the entire contents of `agent/src/matrixInbound.test.ts` with:

```ts
// agent/src/matrixInbound.test.ts
import { describe, expect, test, vi } from "vitest";
import { parseSyncEvents, isAllowedSender, SeenEventIds, handleMatrixInbound, type MatrixInboundContext, type MatrixInboundHandlers } from "./matrixInbound.js";

describe("parseSyncEvents (all joined rooms + invites)", () => {
  const SAMPLE = {
    next_batch: "s2",
    rooms: {
      join: {
        "!alpha:hs": {
          timeline: {
            events: [
              { type: "m.room.message", event_id: "$a", sender: "@me:hs", origin_server_ts: 111, content: { msgtype: "m.text", body: " status " } },
              { type: "m.room.message", event_id: "$b", sender: "@me:hs", origin_server_ts: 222, content: { msgtype: "m.image", body: "pic" } },
              { type: "m.reaction", event_id: "$c", sender: "@me:hs", content: {} },
              { type: "m.room.message", event_id: "$d", sender: "@me:hs", origin_server_ts: 333, content: { msgtype: "m.text", body: "   " } },
            ],
          },
        },
        "!beta:hs": {
          timeline: {
            events: [
              { type: "m.room.message", event_id: "$e", sender: "@me:hs", origin_server_ts: 444, content: { msgtype: "m.text", body: "hello beta" } },
            ],
          },
        },
      },
      invite: {
        "!invited:hs": {
          invite_state: {
            events: [
              { type: "m.room.member", state_key: "@rigel:hs", sender: "@me:hs", content: { membership: "invite" } },
            ],
          },
        },
      },
    },
  };

  test("tags each text message with its originating room id, across rooms", () => {
    const { events, nextBatch } = parseSyncEvents(SAMPLE);
    expect(nextBatch).toBe("s2");
    expect(events).toEqual([
      { eventId: "$a", sender: "@me:hs", body: "status", timestamp: 111, roomId: "!alpha:hs" },
      { eventId: "$e", sender: "@me:hs", body: "hello beta", timestamp: 444, roomId: "!beta:hs" },
    ]);
  });

  test("surfaces invites with their inviter", () => {
    expect(parseSyncEvents(SAMPLE).invites).toEqual([
      { roomId: "!invited:hs", inviter: "@me:hs" },
    ]);
  });

  test("is defensive against malformed input", () => {
    expect(parseSyncEvents(null)).toEqual({ nextBatch: "", events: [], invites: [] });
    expect(parseSyncEvents({})).toEqual({ nextBatch: "", events: [], invites: [] });
    expect(parseSyncEvents({ rooms: "garbage" })).toEqual({ nextBatch: "", events: [], invites: [] });
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
    seen.mark("$3");
    expect(seen.has("$1")).toBe(false);
    expect(seen.has("$3")).toBe(true);
  });
});

function fakeHandlers(over: Partial<MatrixInboundHandlers> = {}): MatrixInboundHandlers & { replies: Array<[string, string]> } {
  const replies: Array<[string, string]> = [];
  return {
    replies,
    sync: vi.fn(async () => ({ next_batch: "s2", rooms: { join: {} } })),
    reply: vi.fn(async (roomId: string, text: string) => { replies.push([roomId, text]); }),
    markRead: vi.fn(async () => {}),
    setTyping: vi.fn(async () => {}),
    join: vi.fn(async () => {}),
    resetThread: vi.fn(async () => {}),
    respond: vi.fn(async (text: string) => `HANDLED: ${text}`),
    ...over,
  };
}

const CTX: MatrixInboundContext = {
  enabled: true,
  homeserverUrl: "https://hs",
  accessToken: "tok",
  allow: ["@me:hs"],
  since: "s1",
};

function syncOneRoom(roomId: string, events: unknown[], nextBatch = "s2") {
  return { next_batch: nextBatch, rooms: { join: { [roomId]: { timeline: { events } } } } };
}

describe("handleMatrixInbound", () => {
  test("returns the prior cursor and does nothing when disabled/unconfigured", async () => {
    const h = fakeHandlers();
    expect(await handleMatrixInbound({ ...CTX, enabled: false }, h, new SeenEventIds())).toBe("s1");
    expect(await handleMatrixInbound({ ...CTX, accessToken: undefined }, h, new SeenEventIds())).toBe("s1");
    expect(h.sync).not.toHaveBeenCalled();
  });

  test("threads by room: respond gets roomId as threadKey and reply targets that room", async () => {
    const raw = syncOneRoom("!alpha:hs", [
      { type: "m.room.message", event_id: "$1", sender: "@me:hs", origin_server_ts: 5, content: { msgtype: "m.text", body: "why down?" } },
    ]);
    const h = fakeHandlers({ sync: vi.fn(async () => raw) });
    const next = await handleMatrixInbound(CTX, h, new SeenEventIds());
    expect(h.respond).toHaveBeenCalledWith("why down?", "@me:hs", 5, "!alpha:hs");
    expect(h.replies).toEqual([["!alpha:hs", "HANDLED: why down?"]]);
    expect(next).toBe("s2");
  });

  test("auto-joins a room when the inviter is on the allowlist", async () => {
    const raw = { next_batch: "s2", rooms: { invite: { "!new:hs": { invite_state: { events: [
      { type: "m.room.member", state_key: "@rigel:hs", sender: "@me:hs", content: { membership: "invite" } },
    ] } } } } };
    const h = fakeHandlers({ sync: vi.fn(async () => raw) });
    await handleMatrixInbound(CTX, h, new SeenEventIds());
    expect(h.join).toHaveBeenCalledWith("!new:hs");
  });

  test("ignores an invite from a non-allowlisted inviter", async () => {
    const raw = { next_batch: "s2", rooms: { invite: { "!spam:hs": { invite_state: { events: [
      { type: "m.room.member", state_key: "@rigel:hs", sender: "@stranger:hs", content: { membership: "invite" } },
    ] } } } } };
    const h = fakeHandlers({ sync: vi.fn(async () => raw) });
    await handleMatrixInbound(CTX, h, new SeenEventIds());
    expect(h.join).not.toHaveBeenCalled();
  });

  test("/reset clears the room thread and confirms, without a model turn", async () => {
    const raw = syncOneRoom("!alpha:hs", [
      { type: "m.room.message", event_id: "$r", sender: "@me:hs", origin_server_ts: 9, content: { msgtype: "m.text", body: "/reset" } },
    ]);
    const h = fakeHandlers({ sync: vi.fn(async () => raw) });
    await handleMatrixInbound(CTX, h, new SeenEventIds());
    expect(h.resetThread).toHaveBeenCalledWith("!alpha:hs");
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.replies).toEqual([["!alpha:hs", "Started a fresh thread in this room."]]);
  });

  test("ignores messages from senders not on the allowlist", async () => {
    const raw = syncOneRoom("!alpha:hs", [
      { type: "m.room.message", event_id: "$1", sender: "@stranger:hs", origin_server_ts: 5, content: { msgtype: "m.text", body: "status" } },
    ]);
    const h = fakeHandlers({ sync: vi.fn(async () => raw) });
    await handleMatrixInbound(CTX, h, new SeenEventIds());
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.replies).toEqual([]);
  });

  test("does not re-process an event id already seen", async () => {
    const raw = syncOneRoom("!alpha:hs", [
      { type: "m.room.message", event_id: "$dup", sender: "@me:hs", origin_server_ts: 5, content: { msgtype: "m.text", body: "status" } },
    ]);
    const h = fakeHandlers({ sync: vi.fn(async () => raw) });
    const seen = new SeenEventIds();
    await handleMatrixInbound(CTX, h, seen);
    await handleMatrixInbound(CTX, h, seen);
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  test("a sync failure is swallowed and keeps the prior cursor", async () => {
    const h = fakeHandlers({ sync: vi.fn(async () => { throw new Error("unreachable"); }) });
    expect(await handleMatrixInbound(CTX, h, new SeenEventIds())).toBe("s1");
    expect(h.replies).toEqual([]);
  });

  test("skips the bot's own messages even when its id is on the allowlist", async () => {
    const botId = "@rigel-bot:hs";
    const raw = syncOneRoom("!alpha:hs", [
      { type: "m.room.message", event_id: "$self1", sender: botId, origin_server_ts: 1, content: { msgtype: "m.text", body: "status" } },
    ]);
    const h = fakeHandlers({ sync: vi.fn(async () => raw) });
    await handleMatrixInbound({ ...CTX, allow: [...CTX.allow, botId], botUserId: botId }, h, new SeenEventIds());
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.replies).toEqual([]);
  });

  test("markRead(roomId,eventId) and setTyping(roomId,bool) fire for an acted-on message, ordered around the reply", async () => {
    const raw = syncOneRoom("!alpha:hs", [
      { type: "m.room.message", event_id: "$auth1", sender: "@me:hs", origin_server_ts: 5, content: { msgtype: "m.text", body: "diagnose this" } },
    ]);
    const h = fakeHandlers({ sync: vi.fn(async () => raw) });
    await handleMatrixInbound(CTX, h, new SeenEventIds());

    expect(h.markRead).toHaveBeenCalledWith("!alpha:hs", "$auth1");
    const typingCalls = (h.setTyping as ReturnType<typeof vi.fn>).mock.calls;
    expect(typingCalls[0]).toEqual(["!alpha:hs", true]);
    expect(typingCalls[1]).toEqual(["!alpha:hs", false]);

    const replyOrder = (h.reply as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const typingTrueOrder = (h.setTyping as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const typingFalseOrder = (h.setTyping as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1]!;
    expect(typingTrueOrder).toBeLessThan(replyOrder);
    expect(replyOrder).toBeLessThan(typingFalseOrder);
  });

  test("markRead and setTyping are NOT called for unauthorized senders", async () => {
    const raw = syncOneRoom("!alpha:hs", [
      { type: "m.room.message", event_id: "$unauth1", sender: "@stranger:hs", origin_server_ts: 5, content: { msgtype: "m.text", body: "status" } },
    ]);
    const h = fakeHandlers({ sync: vi.fn(async () => raw) });
    await handleMatrixInbound(CTX, h, new SeenEventIds());
    expect(h.markRead).not.toHaveBeenCalled();
    expect(h.setTyping).not.toHaveBeenCalled();
  });

  test("chunks a long reply into multiple sends to the same room", async () => {
    const raw = syncOneRoom("!alpha:hs", [
      { type: "m.room.message", event_id: "$1", sender: "@me:hs", origin_server_ts: 5, content: { msgtype: "m.text", body: "explain" } },
    ]);
    const h = fakeHandlers({ sync: vi.fn(async () => raw), respond: vi.fn(async () => "x".repeat(3000)) });
    await handleMatrixInbound(CTX, h, new SeenEventIds());
    expect(h.replies.length).toBeGreaterThan(1);
    expect(h.replies.every(([r]) => r === "!alpha:hs")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C agent exec vitest run src/matrixInbound.test.ts`
Expected: FAIL — `parseSyncEvents` takes a `roomId` arg / no `invites` / handlers don't take `roomId`.

- [ ] **Step 3: Rewrite `matrixInbound.ts`**

Replace the entire contents of `agent/src/matrixInbound.ts` with:

```ts
// agent/src/matrixInbound.ts
import { respondSafely, chunkText, type MessageHandler } from "./signalInbound.js";
/**
 * Inbound Matrix: the operator runs the cluster by texting the bot over Matrix
 * rooms. This is the pure, testable core — parsing the client-server `/sync`
 * payload across ALL joined rooms, discovering invites, authenticating senders
 * against an allowlist of Matrix ids, de-duplicating by `event_id`, and chunking
 * replies. All IO (sync/send HTTP, join, the agent turn) is injected, mirroring
 * signalInbound.ts.
 *
 * One durable conversation thread per room: each event carries its `roomId`,
 * which is used both as the reply target and as the session thread key. The bot
 * auto-joins any room it is invited to by an allowlisted user, so a new topic is
 * started by creating a room and inviting the bot. `/reset` starts that room's
 * thread fresh. There is NO deterministic command parsing otherwise: every
 * authorized message is one conversational, act-capable agent turn.
 */
export interface MatrixEvent {
  /** Matrix event id — the natural de-dupe key. */
  eventId: string;
  /** Full Matrix user id of the sender, e.g. "@me:hs". */
  sender: string;
  /** The trimmed message body. */
  body: string;
  /** origin_server_ts (ms) — the clock for session threading. */
  timestamp: number;
  /** The room this event arrived in — reply target and per-room thread key. */
  roomId: string;
}

/** A pending invite the bot has received but not yet joined. */
export interface MatrixInvite {
  /** The invited room id. */
  roomId: string;
  /** Full Matrix id of whoever sent the invite (gated against the allowlist). */
  inviter: string;
}

export interface MatrixSyncResult {
  events: MatrixEvent[];
  invites: MatrixInvite[];
  /** The `next_batch` cursor to pass as `since` on the following poll. */
  nextBatch: string;
}

/**
 * Parse a `GET /_matrix/client/v3/sync` response: `next_batch`, the timeline
 * `m.room.message`/`m.text` events across every joined room (each tagged with
 * its room id), and pending invites (each with its inviter). Anything malformed
 * is skipped rather than thrown.
 */
export function parseSyncEvents(raw: unknown): MatrixSyncResult {
  const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const nextBatch = typeof root["next_batch"] === "string" ? (root["next_batch"] as string) : "";
  const out: MatrixEvent[] = [];
  const invites: MatrixInvite[] = [];
  const rooms = root["rooms"] && typeof root["rooms"] === "object" ? (root["rooms"] as Record<string, unknown>) : undefined;

  const join = rooms?.["join"] && typeof rooms["join"] === "object" ? (rooms["join"] as Record<string, unknown>) : undefined;
  if (join) {
    for (const [roomId, roomValue] of Object.entries(join)) {
      const room = roomValue && typeof roomValue === "object" ? (roomValue as Record<string, unknown>) : undefined;
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
        out.push({ eventId, sender, body, timestamp, roomId });
      }
    }
  }

  const invite = rooms?.["invite"] && typeof rooms["invite"] === "object" ? (rooms["invite"] as Record<string, unknown>) : undefined;
  if (invite) {
    for (const [roomId, roomValue] of Object.entries(invite)) {
      const room = roomValue && typeof roomValue === "object" ? (roomValue as Record<string, unknown>) : undefined;
      const inviteState = room?.["invite_state"] && typeof room["invite_state"] === "object" ? (room["invite_state"] as Record<string, unknown>) : undefined;
      const events = Array.isArray(inviteState?.["events"]) ? (inviteState!["events"] as unknown[]) : [];
      let inviter = "";
      for (const e of events) {
        const ev = e && typeof e === "object" ? (e as Record<string, unknown>) : null;
        if (!ev || ev["type"] !== "m.room.member") continue;
        const content = ev["content"] && typeof ev["content"] === "object" ? (ev["content"] as Record<string, unknown>) : undefined;
        if (content?.["membership"] !== "invite") continue;
        inviter = typeof ev["sender"] === "string" ? (ev["sender"] as string) : "";
        if (inviter) break;
      }
      invites.push({ roomId, inviter });
    }
  }

  return { events: out, invites, nextBatch };
}

/** Is `sender` on the allowlist? Exact match on the trimmed Matrix id. */
export function isAllowedSender(sender: string, allow: string[]): boolean {
  const s = sender.trim();
  if (!s) return false;
  return allow.some((a) => a.trim() === s);
}

/** Bounded set of processed `event_id`s so a redelivered event is never answered
 *  twice. Oldest ids are evicted past the cap. */
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

export interface MatrixInboundContext {
  /** Whether inbound command handling is turned on. */
  enabled: boolean;
  homeserverUrl?: string;
  accessToken?: string;
  /** Authorized sender Matrix ids (also gates who may invite the bot). */
  allow: string[];
  /** The bot's own Matrix id, so its own sent messages are never processed. */
  botUserId?: string;
  /** The `since` cursor from the last poll (undefined on first run). */
  since?: string;
}

export interface MatrixInboundHandlers extends MessageHandler {
  /** GET /_matrix/client/v3/sync with the stored cursor; returns the parsed body. */
  sync(since: string | undefined): Promise<unknown>;
  /** PUT a reply into `roomId`. */
  reply(roomId: string, text: string): Promise<void>;
  /** POST a read receipt for `eventId` in `roomId` (best-effort). */
  markRead(roomId: string, eventId: string): Promise<void>;
  /** PUT a typing notification into `roomId` (best-effort). */
  setTyping(roomId: string, typing: boolean): Promise<void>;
  /** Join `roomId` after an allowlisted invite (best-effort). */
  join(roomId: string): Promise<void>;
  /** Forget `roomId`'s session so its next message starts a fresh thread. */
  resetThread(roomId: string): Promise<void>;
}

/**
 * One inbound poll: sync from the cursor, auto-join allowlisted invites, then
 * for each fresh authorized message route it to its room's thread (or handle
 * `/reset`) and reply into that room. Never throws — a handler failure becomes an
 * error reply and a sync failure keeps the prior cursor. Returns the new `since`
 * cursor to persist (the prior cursor on a failed sync).
 */
export async function handleMatrixInbound(
  ctx: MatrixInboundContext,
  h: MatrixInboundHandlers,
  seen: SeenEventIds,
): Promise<string | undefined> {
  if (!ctx.enabled || !ctx.homeserverUrl || !ctx.accessToken) return ctx.since;
  let raw: unknown;
  try {
    raw = await h.sync(ctx.since);
  } catch (e) {
    h.log?.(`matrix sync failed: ${String(e)}`);
    return ctx.since;
  }
  const { events, invites, nextBatch } = parseSyncEvents(raw);

  for (const inv of invites) {
    if (!isAllowedSender(inv.inviter, ctx.allow)) {
      h.log?.(`matrix: ignoring invite to ${inv.roomId} from unauthorized ${inv.inviter}`);
      continue;
    }
    try {
      await h.join(inv.roomId);
      h.log?.(`matrix: joined ${inv.roomId} (invited by ${inv.inviter})`);
    } catch (e) {
      h.log?.(`matrix: join ${inv.roomId} failed: ${String(e)}`);
    }
  }

  for (const ev of events) {
    if (seen.has(ev.eventId)) continue;
    seen.mark(ev.eventId);
    if (ctx.botUserId && ev.sender === ctx.botUserId) continue;
    if (!isAllowedSender(ev.sender, ctx.allow)) {
      h.log?.(`matrix: ignoring message from unauthorized sender ${ev.sender}`);
      continue;
    }
    await h.markRead(ev.roomId, ev.eventId);
    if (ev.body === "/reset") {
      await h.resetThread(ev.roomId);
      await h.reply(ev.roomId, "Started a fresh thread in this room.");
      continue;
    }
    await h.setTyping(ev.roomId, true);
    h.log?.(`matrix: message from ${ev.sender} in ${ev.roomId}`);
    const reply = await respondSafely(h, ev.body, ev.sender, ev.timestamp, ev.roomId);
    for (const chunk of chunkText(reply)) {
      await h.reply(ev.roomId, chunk);
    }
    await h.setTyping(ev.roomId, false);
  }
  return nextBatch || ctx.since;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C agent exec vitest run src/matrixInbound.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add agent/src/matrixInbound.ts agent/src/matrixInbound.test.ts
git commit -m "feat(agent): multi-room Matrix inbound with per-room threads, auto-join, and /reset"
```

---

## Task 4: Persist per-room sessions in AssistantState

**Files:**
- Modify: `agent/src/state.ts` (interface `AssistantState`)

- [ ] **Step 1: Add the `threadSessions` field**

In `agent/src/state.ts`, inside the `AssistantState` interface, immediately after the `matrixSince?: string;` field (and its doc comment), add:

```ts
  /** Per-room Matrix `claude` session pointers (`roomId → sessionId`), so each
   *  topic room resumes its durable thread across pod restarts. Written
   *  alongside `matrixSince` on every inbound poll that advances the cursor.
   *  Absent until the first Matrix conversation. */
  threadSessions?: Record<string, string>;
```

`emptyState()` needs no change (the field is optional).

- [ ] **Step 2: Verify the package type-checks**

Run: `pnpm -C agent exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add agent/src/state.ts
git commit -m "feat(agent): persist per-room Matrix session pointers in AssistantState"
```

---

## Task 5: joinMatrixRoom IO helper

**Files:**
- Modify: `agent/src/notify.ts`

- [ ] **Step 1: Add `joinMatrixRoom`**

In `agent/src/notify.ts`, immediately after the `receiveMatrix` function, add:

```ts
/**
 * Join `roomId` via `POST /_matrix/client/v3/rooms/{roomId}/join` (accepting a
 * pending invite). Throws on a transport or non-2xx error so the caller can log
 * and retry on the next poll — the invite persists until accepted.
 */
export async function joinMatrixRoom(
  homeserver: string,
  accessToken: string,
  roomId: string,
): Promise<void> {
  const base = homeserver.replace(/\/+$/, "");
  const res = await fetch(
    `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: "{}",
    },
  );
  if (!res.ok) throw new Error(`matrix join returned ${res.status}`);
}
```

- [ ] **Step 2: Verify the package type-checks**

Run: `pnpm -C agent exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add agent/src/notify.ts
git commit -m "feat(agent): joinMatrixRoom IO helper for accepting invites"
```

---

## Task 6: Wire the durable room store into index.ts

**Files:**
- Modify: `agent/src/index.ts`

This task has no new unit test of its own (it is IO wiring); it is verified by the full agent suite plus a typecheck. Each sub-step is a precise edit against the current code.

- [ ] **Step 1: Import the new symbols**

At the top of `agent/src/index.ts`, find the import of `SessionStore`:

```ts
import { SessionStore } from "./sessionStore.js";
```

and replace it with:

```ts
import { SessionStore, ONE_HOUR_MS } from "./sessionStore.js";
```

Find the import of `joinMatrixRoom`'s siblings from `./notify.js` (the block importing `receiveMatrix`, `notifyMatrix`, `markMatrixRead`, `setMatrixTyping`) and add `joinMatrixRoom` to it. Find the import from `./signalInbound.js` and ensure `normalizeNumber` is included in it (add it if absent).

- [ ] **Step 2: Add `roomSessions` to `LoopState`**

In the `LoopState` interface, after:

```ts
  /** Per-sender claude diagnosis threads (1-hour idle reset, in-memory). */
  sessions: SessionStore;
```

add:

```ts
  /** Per-room Matrix claude threads (durable: no idle reset, persisted to the
   *  state ConfigMap and hydrated on the first inbound poll). */
  roomSessions: SessionStore;
```

- [ ] **Step 3: Construct both stores**

Find the loop construction (currently `sessions: new SessionStore(),` around line 1035) and replace that single line with:

```ts
    sessions: new SessionStore(ONE_HOUR_MS, normalizeNumber),
    roomSessions: new SessionStore(Number.POSITIVE_INFINITY),
```

(The Signal store now injects `normalizeNumber` explicitly — Task 1 removed the built-in normalization — preserving its exact prior behavior.)

- [ ] **Step 4: Give `buildMessageHandler` the store to thread on**

Replace the `buildMessageHandler` signature line:

```ts
function buildMessageHandler(
  cfg: Config,
  rc: RuntimeConfig,
  cb: CircuitBreaker,
  loop: LoopState,
): MessageHandler {
```

with:

```ts
function buildMessageHandler(
  cfg: Config,
  rc: RuntimeConfig,
  cb: CircuitBreaker,
  loop: LoopState,
  sessions: SessionStore,
): MessageHandler {
```

Then replace the `respond` implementation inside it:

```ts
    respond: async (message, source, timestamp) => {
```

with:

```ts
    respond: async (message, source, timestamp, threadKey) => {
```

and, in that same function, change the `runThreadedDiagnosis` call's `sessions` field and thread key. Replace:

```ts
      const reply = await runThreadedDiagnosis(
        {
          sessions: loop.sessions,
          diagnose: (q, resumeId) => runChatTurn(rc, q, resumeId),
          log,
        },
        source,
        timestamp,
        framed,
      );
```

with:

```ts
      const reply = await runThreadedDiagnosis(
        {
          sessions,
          diagnose: (q, resumeId) => runChatTurn(rc, q, resumeId),
          log,
        },
        threadKey ?? source,
        timestamp,
        framed,
      );
```

`executeChatAction` still receives the real `source` for its audit actor/fingerprint — leave that call untouched.

- [ ] **Step 5: Pass the Signal store at the Signal call site**

In `handleSignalInbound`, replace:

```ts
    ...buildMessageHandler(cfg, rc, cb, loop),
```

with:

```ts
    ...buildMessageHandler(cfg, rc, cb, loop, loop.sessions),
```

- [ ] **Step 6: Relax the inbound gate (multi-room no longer needs a fixed room)**

In `tick`, replace:

```ts
    if (rc.matrix.homeserverUrl && rc.matrix.accessToken && rc.matrix.roomId) {
```

with:

```ts
    if (rc.matrix.homeserverUrl && rc.matrix.accessToken) {
```

- [ ] **Step 7: Rewire `handleMatrixInboundIO` for multi-room + persistence**

Replace the body of `handleMatrixInboundIO` from the `if (loop.matrixSince === undefined)` block through the end of the function with:

```ts
  if (loop.matrixSince === undefined) {
    const s = await readState(cfg.stateConfigMap, cfg.stateNamespace);
    loop.matrixSince = s.matrixSince;
    loop.roomSessions.load(s.threadSessions, Date.now());
  }
  const handlers: MatrixInboundHandlers = {
    sync: (since) => receiveMatrix(m.homeserverUrl!, m.accessToken!, since),
    reply: (roomId, text) => notifyMatrix(m.homeserverUrl!, m.accessToken!, roomId, text),
    markRead: (roomId, eventId) => markMatrixRead(m.homeserverUrl!, m.accessToken!, roomId, eventId),
    setTyping: (roomId, typing) => setMatrixTyping(m.homeserverUrl!, m.accessToken!, roomId, m.userId ?? "", typing),
    join: (roomId) => joinMatrixRoom(m.homeserverUrl!, m.accessToken!, roomId),
    resetThread: async (roomId) => { loop.roomSessions.clear(roomId); },
    ...buildMessageHandler(cfg, rc, cb, loop, loop.roomSessions),
  };
  const next = await handleMatrixInbound(
    { enabled: true, homeserverUrl: m.homeserverUrl, accessToken: m.accessToken, allow, botUserId: m.userId, since: loop.matrixSince },
    handlers,
    loop.seenMatrix,
  );
  if (next !== loop.matrixSince) {
    loop.matrixSince = next;
    const s = await readState(cfg.stateConfigMap, cfg.stateNamespace);
    await writeState(cfg.stateConfigMap, cfg.stateNamespace, { ...s, matrixSince: next, threadSessions: loop.roomSessions.snapshot() });
  }
```

Note the removed `roomId` from the `MatrixInboundContext` object literal (the pure core no longer takes it) — this matches Task 3's interface.

- [ ] **Step 8: Verify the package type-checks**

Run: `pnpm -C agent exec tsc --noEmit`
Expected: PASS. If `tsc` reports `roomId` still referenced on `MatrixInboundContext`, or `reply`/`markRead`/`setTyping` arity mismatches, fix the offending call to match Task 3's signatures.

- [ ] **Step 9: Run the full agent suite**

Run: `pnpm -C agent test`
Expected: PASS (all suites, including the untouched digest/notify/threadedDiagnosis tests).

- [ ] **Step 10: Commit**

```bash
git add agent/src/index.ts
git commit -m "feat(agent): durable per-room Matrix sessions wired through the inbound loop"
```

---

## Task 7: PVC + HOME for durable transcripts in the rendered Deployment

**Files:**
- Modify: `packages/k8s/src/assistant.ts`
- Test: `packages/k8s/src/assistant.test.ts`

The session ids persisted in Task 6 are only resumable if the `claude` CLI's transcript files survive a restart. Mount a PVC at the CLI's `HOME`.

- [ ] **Step 1: Add failing tests**

Append the following to `packages/k8s/src/assistant.test.ts` (adjust the import line at the top of that file to include `pvc` and, if not already imported, `deployment` and `manifestYAML` from `./assistant.js`). Use a minimal config literal matching the shape the other tests in this file already build — copy the `AssistantInstallConfig` fixture they use and name it `cfg` here if one isn't already in scope:

```ts
import { describe, expect, test } from "vitest";
import { deployment, pvc, manifestYAML } from "./assistant.js";

// Reuse this file's existing AssistantInstallConfig fixture. If the suite already
// defines one (e.g. `baseConfig`), replace `TEST_CFG` below with it.
const TEST_CFG = {
  installNamespace: "rigel-assistant",
  image: "ghcr.io/rigel/agent:test",
  workerModel: "claude-sonnet-4-6",
  supervisorModel: "claude-opus-4-8",
  pollIntervalMs: 30000,
  maxPerResourcePerHour: 3,
  maxPerNight: 20,
  maxAttemptsPerIncident: 3,
  confirmPolls: 2,
  namespaces: "",
} as unknown as Parameters<typeof deployment>[0];

describe("durable transcript PVC", () => {
  test("pvc() renders a 1Gi RWO claim in the install namespace", () => {
    const y = pvc(TEST_CFG);
    expect(y).toContain("kind: PersistentVolumeClaim");
    expect(y).toContain("name: rigel-assistant-data");
    expect(y).toContain("namespace: rigel-assistant");
    expect(y).toContain("ReadWriteOnce");
    expect(y).toContain("storage: 1Gi");
  });

  test("deployment mounts the PVC at a persistent HOME", () => {
    const y = deployment(TEST_CFG);
    expect(y).toContain("name: HOME");
    expect(y).toContain("value: /home/agent");
    expect(y).toContain("mountPath: /home/agent");
    expect(y).toContain("claimName: rigel-assistant-data");
    // Single-writer safety for the RWO volume is already in place.
    expect(y).toContain("type: Recreate");
  });

  test("manifestYAML includes the PVC document", () => {
    expect(manifestYAML(TEST_CFG)).toContain("kind: PersistentVolumeClaim");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rigel/k8s exec vitest run src/assistant.test.ts`
Expected: FAIL — `pvc` is not exported; `HOME`/`mountPath`/`claimName` absent.

- [ ] **Step 3: Add the `HOME` env, volumeMount, and volume to `deployment()`**

In `packages/k8s/src/assistant.ts`, inside the `deployment()` template, add the `HOME` env var. Immediately after the `env:` line and its `${credentialEnvYAML(sources)}` interpolation, insert as the first fixed env entry:

```yaml
            - name: HOME
              value: /home/agent
```

(Concretely: the block currently reads `          env:\n${credentialEnvYAML(sources)}\n            - name: WORKER_MODEL`. Put the `HOME` entry between `${credentialEnvYAML(sources)}` and `- name: WORKER_MODEL`.)

Next, add a `volumeMounts` block to the container. Find the container's `securityContext` block that precedes `resources`:

```yaml
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          resources:
```

and insert the mount between `capabilities` and `resources`:

```yaml
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: agent-home
              mountPath: /home/agent
          resources:
```

Finally, add a `volumes` block as a sibling of `containers` under the pod `spec`. The template ends with the container `resources` block:

```yaml
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              cpu: "1"
              memory: 512Mi`;
```

Change it to append the pod-level `volumes` (6-space indent, sibling of `containers:`):

```yaml
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              cpu: "1"
              memory: 512Mi
      volumes:
        - name: agent-home
          persistentVolumeClaim:
            claimName: rigel-assistant-data`;
```

(The `fsGroup: 1000` already in the pod `securityContext` makes the mounted volume group-writable for the non-root uid 1000, so the CLI can write `/home/agent/.claude`.)

- [ ] **Step 4: Add the `pvc()` renderer and include it in `manifestYAML`**

Immediately before the `manifestYAML` function, add:

```ts
/** The durable transcript volume: a 1Gi RWO claim mounted at the agent's HOME so
 *  `claude` CLI session transcripts survive pod restarts (session pointers are
 *  persisted separately in AssistantState). Applied with the rest of the
 *  manifest; the single-replica + Recreate Deployment is the only writer. */
export function pvc(c: AssistantInstallConfig): string {
  return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: rigel-assistant-data
  namespace: ${c.installNamespace}
  labels:
    app.kubernetes.io/name: rigel-assistant
    app.kubernetes.io/managed-by: rigel-assistant
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi`;
}
```

Then, in `manifestYAML`, replace:

```ts
  return [rbac(c.installNamespace, c.rbacPolicy ?? DEFAULT_POLICY), configMaps(c), deployment(c)].join("\n---\n");
```

with:

```ts
  return [rbac(c.installNamespace, c.rbacPolicy ?? DEFAULT_POLICY), configMaps(c), pvc(c), deployment(c)].join("\n---\n");
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rigel/k8s exec vitest run src/assistant.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full k8s package suite (guard against snapshot/manifest tests)**

Run: `pnpm --filter @rigel/k8s test`
Expected: PASS. If a pre-existing manifest snapshot test fails purely because the manifest now contains the PVC/HOME/volume, update that snapshot (`vitest -u`) — it is an expected manifest change, not a regression.

- [ ] **Step 7: Commit**

```bash
git add packages/k8s/src/assistant.ts packages/k8s/src/assistant.test.ts
git commit -m "feat(k8s): mount a durable PVC at the agent HOME so claude transcripts survive restarts"
```

---

## Task 8: Full build, whole-repo verification, and docs

**Files:**
- Verify only (plus any Outline/Plane follow-ups per project workflow).

- [ ] **Step 1: Build the agent package**

Run: `pnpm -C agent build`
Expected: PASS (no type errors).

- [ ] **Step 2: Build the k8s package**

Run: `pnpm --filter @rigel/k8s build`
Expected: PASS.

- [ ] **Step 3: Run the server suite (consumes the k8s renderer)**

Run: `pnpm --filter @rigel/server test`
Expected: PASS — nothing in the server relies on the removed `parseSyncEvents(raw, roomId)` arity or the old handler signatures (those live in `agent/`), but run it to confirm the shared k8s manifest change didn't break an install/reconcile test.

- [ ] **Step 4: Confirm the full agent suite is green**

Run: `pnpm -C agent test`
Expected: PASS.

- [ ] **Step 5: Update the app docs (project workflow)**

Per the repo's docs+tickets workflow, update the Assistant/Matrix documentation in Outline to describe: per-room durable threads, invite-to-start-a-topic, `/reset`, and the new `rigel-assistant-data` PVC. Derive any follow-up tickets in Plane from those docs (e.g. surfacing joined rooms in the desktop panel). Do not create testing/QA tickets.

- [ ] **Step 6: Final commit (if docs code changed) and mark the branch ready**

If any in-repo docs changed, commit them. Then follow the repo's branch workflow: the draft PR for `feature/matrix-per-room-sessions` is marked ready for review once all suites above are green.

---

## Self-review

**Spec coverage:**
- Multi-room inbound + `roomId`-tagged events → Task 3. ✓
- Auto-join, allowlisted-inviter-only → Task 3 (`join` handler + gating) + Task 5 (`joinMatrixRoom`). ✓
- Per-room reply/markRead/setTyping targeting → Task 3 (handler arity) + Task 6 (wiring). ✓
- `threadKey` re-keying (Matrix→room, Signal→sender) → Task 2 (seam) + Task 3 (Matrix passes `roomId`) + Task 6 (`threadKey ?? source`, Signal unchanged). ✓
- No idle reset for rooms / opaque keys → Task 1 (`Number.POSITIVE_INFINITY` store, injectable `normalizeKey`) + Task 6 (construction). ✓
- Write-through persistence to state ConfigMap → Task 4 (`threadSessions` field) + Task 6 (hydrate on first poll, persist on cursor write). ✓
- Transcript PVC + `HOME` + `Recreate` → Task 7 (PVC/mount/HOME; `Recreate` already present). ✓
- `/reset` per room → Task 3 (`resetThread` handler + confirmation) + Task 6 (clears `roomSessions`). ✓
- `roomId` retained for outbound broadcast → not removed anywhere; gate relaxed only for inbound (Task 6 Step 6). ✓
- Resume-failure self-heal (clear + fresh) → preserved: `runThreadedDiagnosis` already clears on a failed resume; the durable store's `clear` is unchanged (Task 1). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the one fixture note (`TEST_CFG` → reuse existing fixture) is an explicit instruction, not a gap.

**Type consistency:** `SessionStore(ttlMs, normalizeKey)`, `snapshot()`, `load(snapshot, nowMs)`, `clear(key)` used consistently across Tasks 1/6. `MatrixInboundHandlers` arity (`reply`/`markRead`/`setTyping`/`join`/`resetThread` all take `roomId` first) matches between Task 3 (definition + tests) and Task 6 (wiring). `respond(text, source, timestamp, threadKey?)` matches across Tasks 2/3/6. `threadSessions?: Record<string,string>` matches between Task 4 (state) and Task 6 (`snapshot()`/`load()`).
