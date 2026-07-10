import { describe, expect, test, vi } from "vitest";
import {
  chunkText,
  handleInbound,
  isAuthorized,
  normalizeNumber,
  parseReceived,
  respondSafely,
  SeenTimestamps,
  type InboundHandlers,
  type MessageHandler,
} from "./signalInbound.js";

describe("normalizeNumber / isAuthorized", () => {
  test("normalizes spacing and punctuation", () => {
    expect(normalizeNumber("+1 (555) 010-1234")).toBe("+15550101234");
    expect(normalizeNumber("+1.555.010.1234")).toBe("+15550101234");
  });
  test("authorizes only allowlisted numbers, format-insensitively", () => {
    const allow = ["+1 555 010 1234"];
    expect(isAuthorized("+15550101234", allow)).toBe(true);
    expect(isAuthorized("+1 (555) 010-1234", allow)).toBe(true);
    expect(isAuthorized("+15559999999", allow)).toBe(false);
    expect(isAuthorized("", allow)).toBe(false);
  });
});

describe("parseReceived", () => {
  test("extracts source/timestamp/text from data messages", () => {
    const raw = [
      { envelope: { sourceNumber: "+15550101234", timestamp: 111, dataMessage: { timestamp: 222, message: " status " } } },
    ];
    expect(parseReceived(raw)).toEqual([{ source: "+15550101234", timestamp: 222, text: "status" }]);
  });
  test("falls back to source and envelope timestamp", () => {
    const raw = [{ envelope: { source: "+15550101234", timestamp: 999, dataMessage: { message: "hi" } } }];
    expect(parseReceived(raw)).toEqual([{ source: "+15550101234", timestamp: 999, text: "hi" }]);
  });
  test("extracts text from a sync sentMessage (send-to-self on a linked device)", () => {
    const raw = [
      {
        envelope: {
          sourceNumber: "+15550101234",
          timestamp: 111,
          syncMessage: { sentMessage: { timestamp: 333, message: " why is payments down? ", destinationNumber: "+15550101234" } },
        },
      },
    ];
    expect(parseReceived(raw)).toEqual([{ source: "+15550101234", timestamp: 333, text: "why is payments down?" }]);
  });
  test("skips receipts, typing, empty and malformed entries", () => {
    const raw = [
      { envelope: { source: "+1", receiptMessage: { when: 1 } } }, // no dataMessage
      { envelope: { source: "+1", dataMessage: { message: "   " } } }, // empty text
      { envelope: { dataMessage: { message: "no source" } } }, // no source
      "garbage",
      null,
    ];
    expect(parseReceived(raw)).toEqual([]);
  });
  test("returns empty for non-array input", () => {
    expect(parseReceived(null)).toEqual([]);
    expect(parseReceived({})).toEqual([]);
  });
});

describe("chunkText", () => {
  test("returns a single chunk when short", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
  });
  test("returns nothing for empty input", () => {
    expect(chunkText("   ")).toEqual([]);
  });
  test("splits long text into numbered chunks under the limit", () => {
    const long = "a ".repeat(2000); // 4000 chars
    const chunks = chunkText(long, 1400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1400 + 10); // + "(n/m) " prefix
    expect(chunks[0]).toMatch(/^\(1\/\d+\) /);
  });
});

describe("SeenTimestamps", () => {
  test("dedupes by source+timestamp and evicts past the cap", () => {
    const seen = new SeenTimestamps(2);
    expect(seen.has("+1", 1)).toBe(false);
    seen.mark("+1", 1);
    expect(seen.has("+1", 1)).toBe(true);
    seen.mark("+1", 2);
    seen.mark("+1", 3); // evicts (+1,1)
    expect(seen.has("+1", 1)).toBe(false);
    expect(seen.has("+1", 3)).toBe(true);
  });
});

function fakeHandlers(over: Partial<InboundHandlers> = {}): InboundHandlers & {
  replies: Array<{ to: string; text: string }>;
} {
  const replies: Array<{ to: string; text: string }> = [];
  return {
    replies,
    receive: vi.fn(async () => []),
    reply: vi.fn(async (to: string, text: string) => {
      replies.push({ to, text });
    }),
    respond: vi.fn(async (text: string, _source: string, _ts: number) => `HANDLED: ${text}`),
    ...over,
  };
}

const CTX = { enabled: true, apiUrl: "http://bridge:8080", number: "+1999", allow: ["+15550101234"] };

describe("handleInbound", () => {
  test("does nothing when disabled or unconfigured", async () => {
    const h = fakeHandlers();
    await handleInbound({ ...CTX, enabled: false }, h, new SeenTimestamps());
    await handleInbound({ ...CTX, apiUrl: undefined }, h, new SeenTimestamps());
    expect(h.receive).not.toHaveBeenCalled();
  });

  test("runs an inbound message from an authorized sender through the agent", async () => {
    const raw = [{ envelope: { sourceNumber: "+15550101234", dataMessage: { timestamp: 1, message: "why down?" } } }];
    const h = fakeHandlers({ receive: vi.fn(async () => raw) });
    await handleInbound(CTX, h, new SeenTimestamps());
    expect(h.respond).toHaveBeenCalledWith("why down?", "+15550101234", 1);
    expect(h.replies).toEqual([{ to: "+15550101234", text: "HANDLED: why down?" }]);
  });

  test("ignores messages from unauthorized senders", async () => {
    const raw = [{ envelope: { sourceNumber: "+15559999999", dataMessage: { timestamp: 1, message: "status" } } }];
    const h = fakeHandlers({ receive: vi.fn(async () => raw) });
    await handleInbound(CTX, h, new SeenTimestamps());
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.replies).toEqual([]);
  });

  test("an affirmative is just another message — no keyword routing", async () => {
    const raw = [{ envelope: { sourceNumber: "+15550101234", dataMessage: { timestamp: 3, message: "Yes let's fix it" } } }];
    const h = fakeHandlers({ receive: vi.fn(async () => raw) });
    await handleInbound(CTX, h, new SeenTimestamps());
    expect(h.respond).toHaveBeenCalledWith("Yes let's fix it", "+15550101234", 3);
    expect(h.replies.map((r) => r.text)).toEqual(["HANDLED: Yes let's fix it"]);
  });

  test("does not re-process a message already seen", async () => {
    const raw = [{ envelope: { sourceNumber: "+15550101234", dataMessage: { timestamp: 7, message: "status" } } }];
    const h = fakeHandlers({ receive: vi.fn(async () => raw) });
    const seen = new SeenTimestamps();
    await handleInbound(CTX, h, seen);
    await handleInbound(CTX, h, seen); // same message redelivered
    expect(h.respond).toHaveBeenCalledTimes(1);
  });

  test("a handler error becomes an error reply, not a throw", async () => {
    const raw = [{ envelope: { sourceNumber: "+15550101234", dataMessage: { timestamp: 1, message: "boom?" } } }];
    const h = fakeHandlers({
      receive: vi.fn(async () => raw),
      respond: vi.fn(async () => {
        throw new Error("model down");
      }),
    });
    await handleInbound(CTX, h, new SeenTimestamps());
    expect(h.replies[0]!.text).toContain("model down");
  });

  test("a receive failure is swallowed", async () => {
    const h = fakeHandlers({
      receive: vi.fn(async () => {
        throw new Error("bridge unreachable");
      }),
    });
    await expect(handleInbound(CTX, h, new SeenTimestamps())).resolves.toBeUndefined();
    expect(h.replies).toEqual([]);
  });

  test("chunks a long reply into multiple sends", async () => {
    const raw = [{ envelope: { sourceNumber: "+15550101234", dataMessage: { timestamp: 1, message: "explain" } } }];
    const h = fakeHandlers({
      receive: vi.fn(async () => raw),
      respond: vi.fn(async () => "x".repeat(3000)),
    });
    await handleInbound(CTX, h, new SeenTimestamps());
    expect(h.replies.length).toBeGreaterThan(1);
  });
});

describe("respondSafely", () => {
  const handler: MessageHandler = {
    respond: async (text: string, source: string, ts: number) => `DX ${text} ${source} ${ts}`,
  };

  test("passes the message + sender + timestamp straight to the agent", async () => {
    expect(await respondSafely(handler, "why?", "@me:hs", 42)).toBe("DX why? @me:hs 42");
  });

  test("turns a handler throw into an error reply string", async () => {
    const boom: MessageHandler = { respond: async () => { throw new Error("down"); } };
    expect(await respondSafely(boom, "why?", "+1", 0)).toContain("down");
  });
});
