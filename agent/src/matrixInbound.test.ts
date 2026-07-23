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
