// agent/src/matrixInbound.test.ts
import { describe, expect, test, vi } from "vitest";
import { parseSyncEvents, isAllowedSender, SeenEventIds, handleMatrixInbound, type MatrixInboundContext, type MatrixInboundHandlers } from "./matrixInbound.js";

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

  test("skips messages from the bot's own id even when that id is on the allowlist", async () => {
    const botId = "@rigel-bot:hs";
    const raw = syncWith([
      { type: "m.room.message", event_id: "$self1", sender: botId, origin_server_ts: 1, content: { msgtype: "m.text", body: "status" } },
    ]);
    const h = fakeHandlers({ sync: vi.fn(async () => raw) });
    // Include the bot id in allow to prove the self-skip wins over the allowlist.
    await handleMatrixInbound({ ...CTX, allow: [...CTX.allow, botId], botUserId: botId }, h, new SeenEventIds());
    expect(h.status).not.toHaveBeenCalled();
    expect(h.diagnose).not.toHaveBeenCalled();
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
