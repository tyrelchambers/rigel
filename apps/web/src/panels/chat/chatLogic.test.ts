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
  appendToolActivity,
  applyToolResult,
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
  it("separates consecutive text blocks with a blank line", () => {
    const msgs: ChatMessage[] = [{ id: "1", role: "assistant", text: "Let me investigate." }];
    const next = appendTextDelta(msgs, "A pnpm monorepo.");
    expect(next).toHaveLength(1);
    expect(next[0].text).toBe("Let me investigate.\n\nA pnpm monorepo.");
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
    expect(out).toContain("Rigel: Sure.");
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

describe("appendToolActivity", () => {
  const ev = {
    toolId: "tool-abc",
    toolName: "Bash",
    command: "kubectl get pods",
    description: "List pods",
    inputJSON: '{"command":"kubectl get pods"}',
  };

  it("appends a system message with status running", () => {
    const next = appendToolActivity([], ev);
    expect(next).toHaveLength(1);
    expect(next[0].role).toBe("system");
    expect(next[0].tool?.status).toBe("running");
  });

  it("carries the tool id, name, command, description and inputJSON", () => {
    const next = appendToolActivity([], ev);
    const tool = next[0].tool!;
    expect(tool.id).toBe("tool-abc");
    expect(tool.name).toBe("Bash");
    expect(tool.command).toBe("kubectl get pods");
    expect(tool.description).toBe("List pods");
    expect(tool.inputJSON).toBe('{"command":"kubectl get pods"}');
  });

  it("preserves existing messages", () => {
    const msgs: ChatMessage[] = [makeMessage("user", "hi")];
    const next = appendToolActivity(msgs, ev);
    expect(next).toHaveLength(2);
    expect(next[0].role).toBe("user");
  });
});

describe("applyToolResult", () => {
  const base: ChatMessage[] = [
    makeMessage("user", "do it"),
    {
      id: "sys-1",
      role: "system",
      text: "",
      tool: {
        id: "tool-abc",
        name: "Bash",
        command: "kubectl get pods",
        inputJSON: "{}",
        status: "running",
      },
    },
    makeMessage("assistant", "done"),
  ];

  it("flips status to ok and sets output on success", () => {
    const next = applyToolResult(base, "tool-abc", false, "out");
    const toolMsg = next[1];
    expect(toolMsg.tool?.status).toBe("ok");
    expect(toolMsg.tool?.output).toBe("out");
  });

  it("flips status to error on failure", () => {
    const next = applyToolResult(base, "tool-abc", true, "denied");
    expect(next[1].tool?.status).toBe("error");
    expect(next[1].tool?.output).toBe("denied");
  });

  it("leaves non-matching messages untouched", () => {
    const next = applyToolResult(base, "tool-abc", false, "out");
    expect(next[0]).toBe(base[0]);
    expect(next[2]).toBe(base[2]);
  });

  it("is a no-op for an unknown tool id", () => {
    const next = applyToolResult(base, "tool-unknown", false, "out");
    expect(next).toEqual(base);
  });
});
