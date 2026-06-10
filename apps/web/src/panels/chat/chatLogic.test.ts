import { describe, it, expect } from "vitest";
import {
  isNearBottom,
  showJumpToNewest,
  appendTextDelta,
  stampThinking,
  elapsedSeconds,
  transcript,
  shortSessionId,
  thinkingVerb,
  makeMessage,
  AT_BOTTOM_THRESHOLD,
} from "./chatLogic";
import { stripActionBlocks } from "@/lib/actionBlocks";
import type { ChatMessage } from "./types";

describe("isNearBottom (24px threshold)", () => {
  it("is true at the exact bottom", () => {
    expect(isNearBottom(900, 100, 1000)).toBe(true);
  });
  it("is true within the threshold", () => {
    // gap = 1000 - (877 + 100) = 23 < 24
    expect(isNearBottom(877, 100, 1000)).toBe(true);
  });
  it("is false at the threshold boundary", () => {
    // gap = 1000 - (876 + 100) = 24, not < 24
    expect(isNearBottom(876, 100, 1000)).toBe(false);
  });
  it("is false when scrolled well up", () => {
    expect(isNearBottom(0, 100, 1000)).toBe(false);
  });
  it("honors the default threshold constant", () => {
    expect(AT_BOTTOM_THRESHOLD).toBe(24);
  });
});

describe("showJumpToNewest", () => {
  it("shows only when scrolled up with messages present", () => {
    expect(showJumpToNewest(false, 3)).toBe(true);
  });
  it("hides when pinned to bottom", () => {
    expect(showJumpToNewest(true, 3)).toBe(false);
  });
  it("hides when there are no messages", () => {
    expect(showJumpToNewest(false, 0)).toBe(false);
  });
});

describe("appendTextDelta", () => {
  it("appends to the trailing assistant message", () => {
    const msgs: ChatMessage[] = [{ id: "1", role: "assistant", text: "Here" }];
    const next = appendTextDelta(msgs, " are the pods");
    expect(next).toHaveLength(1);
    expect(next[0].text).toBe("Here are the pods");
  });
  it("starts a new assistant message when the last is a user message", () => {
    const msgs: ChatMessage[] = [{ id: "1", role: "user", text: "hi" }];
    const next = appendTextDelta(msgs, "hello");
    expect(next).toHaveLength(2);
    expect(next[1].role).toBe("assistant");
    expect(next[1].text).toBe("hello");
  });
  it("starts a new assistant message when there are no messages", () => {
    const next = appendTextDelta([], "first");
    expect(next).toHaveLength(1);
    expect(next[0].role).toBe("assistant");
  });
});

describe("stampThinking (turn end)", () => {
  it("stamps thinking + seconds onto the last assistant message", () => {
    const msgs: ChatMessage[] = [{ id: "1", role: "assistant", text: "answer" }];
    const next = stampThinking(msgs, "let me think", 7);
    expect(next[0].thinking).toBe("let me think");
    expect(next[0].thinkingSeconds).toBe(7);
  });
  it("is a no-op when thinking is empty", () => {
    const msgs: ChatMessage[] = [{ id: "1", role: "assistant", text: "answer" }];
    expect(stampThinking(msgs, "   ", 3)).toBe(msgs);
  });
  it("is a no-op when the last message is not assistant", () => {
    const msgs: ChatMessage[] = [{ id: "1", role: "user", text: "q" }];
    expect(stampThinking(msgs, "thoughts", 3)).toBe(msgs);
  });
});

describe("elapsedSeconds", () => {
  it("rounds to whole seconds between two instants", () => {
    const start = new Date(1000);
    const end = new Date(8600); // 7.6s → 8
    expect(elapsedSeconds(start, end)).toBe(8);
  });
  it("never goes negative", () => {
    expect(elapsedSeconds(new Date(5000), new Date(0))).toBe(0);
  });
});

describe("thinkingVerb rotation", () => {
  it("cycles through the verb list", () => {
    expect(thinkingVerb(0)).toBe("Thinking");
    expect(thinkingVerb(5)).toBe("Thinking");
    expect(thinkingVerb(1)).toBe("Investigating");
  });
});

describe("transcript", () => {
  it("labels roles and strips action blocks from assistant text", () => {
    const msgs: ChatMessage[] = [
      makeMessage("user", "restart web"),
      {
        id: "a",
        role: "assistant",
        text: 'Sure.\n\n```action\n{"label":"Restart","kind":"restart","name":"web"}\n```',
      },
    ];
    const out = transcript(msgs, stripActionBlocks);
    expect(out).toContain("You: restart web");
    expect(out).toContain("Helmsman: Sure.");
    expect(out).not.toContain("```action");
  });
});

describe("shortSessionId", () => {
  it("returns the first 8 chars", () => {
    expect(shortSessionId("0123456789abcdef")).toBe("01234567");
  });
  it("returns null for no session", () => {
    expect(shortSessionId(null)).toBeNull();
  });
});
