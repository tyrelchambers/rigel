import { describe, expect, test, vi } from "vitest";
import {
  chunkText,
  dispatchCommand,
  handleInbound,
  HELP_TEXT,
  isAuthorized,
  normalizeNumber,
  parseCommand,
  parseReceived,
  SeenTimestamps,
  type CommandHandlers,
  type InboundHandlers,
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

describe("parseCommand", () => {
  test("recognizes keyword commands case-insensitively", () => {
    expect(parseCommand("help")).toEqual({ kind: "help" });
    expect(parseCommand("  STATUS ")).toEqual({ kind: "status" });
    expect(parseCommand("queue")).toEqual({ kind: "queue" });
    expect(parseCommand("?")).toEqual({ kind: "help" });
  });
  test("parses approve with and without an index (1-based → 0-based)", () => {
    expect(parseCommand("approve")).toEqual({ kind: "approve", index: 0 });
    expect(parseCommand("approve 3")).toEqual({ kind: "approve", index: 2 });
    expect(parseCommand("approve #2")).toEqual({ kind: "approve", index: 1 });
    expect(parseCommand("yes")).toEqual({ kind: "approve", index: 0 });
    expect(parseCommand("do it")).toEqual({ kind: "approve", index: 0 });
  });
  test("treats free text as a diagnosis question", () => {
    expect(parseCommand("why is payments crashlooping?")).toEqual({
      kind: "diagnose",
      text: "why is payments crashlooping?",
    });
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
    help: () => HELP_TEXT,
    status: vi.fn(async () => "STATUS"),
    queue: vi.fn(async () => "QUEUE"),
    approve: vi.fn(async (i: number) => `APPROVED ${i}`),
    diagnose: vi.fn(async (q: string, _source: string, _ts: number) => `DIAGNOSED: ${q}`),
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

  test("routes a diagnosis question from an authorized sender", async () => {
    const raw = [{ envelope: { sourceNumber: "+15550101234", dataMessage: { timestamp: 1, message: "why down?" } } }];
    const h = fakeHandlers({ receive: vi.fn(async () => raw) });
    await handleInbound(CTX, h, new SeenTimestamps());
    expect(h.diagnose).toHaveBeenCalledWith("why down?", "+15550101234", 1);
    expect(h.replies).toEqual([{ to: "+15550101234", text: "DIAGNOSED: why down?" }]);
  });

  test("ignores messages from unauthorized senders", async () => {
    const raw = [{ envelope: { sourceNumber: "+15559999999", dataMessage: { timestamp: 1, message: "status" } } }];
    const h = fakeHandlers({ receive: vi.fn(async () => raw) });
    await handleInbound(CTX, h, new SeenTimestamps());
    expect(h.status).not.toHaveBeenCalled();
    expect(h.replies).toEqual([]);
  });

  test("routes status/queue/approve commands", async () => {
    const raw = [
      { envelope: { sourceNumber: "+15550101234", dataMessage: { timestamp: 1, message: "status" } } },
      { envelope: { sourceNumber: "+15550101234", dataMessage: { timestamp: 2, message: "queue" } } },
      { envelope: { sourceNumber: "+15550101234", dataMessage: { timestamp: 3, message: "approve 2" } } },
    ];
    const h = fakeHandlers({ receive: vi.fn(async () => raw) });
    await handleInbound(CTX, h, new SeenTimestamps());
    expect(h.approve).toHaveBeenCalledWith(1);
    expect(h.replies.map((r) => r.text)).toEqual(["STATUS", "QUEUE", "APPROVED 1"]);
  });

  test("does not re-process a message already seen", async () => {
    const raw = [{ envelope: { sourceNumber: "+15550101234", dataMessage: { timestamp: 7, message: "status" } } }];
    const h = fakeHandlers({ receive: vi.fn(async () => raw) });
    const seen = new SeenTimestamps();
    await handleInbound(CTX, h, seen);
    await handleInbound(CTX, h, seen); // same message redelivered
    expect(h.status).toHaveBeenCalledTimes(1);
  });

  test("a handler error becomes an error reply, not a throw", async () => {
    const raw = [{ envelope: { sourceNumber: "+15550101234", dataMessage: { timestamp: 1, message: "boom?" } } }];
    const h = fakeHandlers({
      receive: vi.fn(async () => raw),
      diagnose: vi.fn(async () => {
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
      diagnose: vi.fn(async () => "x".repeat(3000)),
    });
    await handleInbound(CTX, h, new SeenTimestamps());
    expect(h.replies.length).toBeGreaterThan(1);
  });
});

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
