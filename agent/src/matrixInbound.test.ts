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
