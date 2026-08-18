import { describe, expect, test } from "vitest";
import { toHistoryEntry } from "./voiceHistory";

describe("toHistoryEntry", () => {
  test("maps final segments to user/assistant messages under one session id", () => {
    const entry = toHistoryEntry(
      "voice-abc",
      1000,
      [
        { id: "s1", text: "restart web", fromAgent: false },
        { id: "s2", text: "Proposed a restart of web.", fromAgent: true },
      ],
      2000,
    );
    expect(entry.id).toBe("voice-abc");
    expect(entry.title).toBe("Voice session");
    expect(entry.createdAt).toBe(1000);
    expect(entry.updatedAt).toBe(2000);
    expect(entry.sessionId).toBeNull();
    expect(entry.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "restart web"],
      ["assistant", "Proposed a restart of web."],
    ]);
  });

  test("empty segments produce no messages", () => {
    expect(toHistoryEntry("voice-x", 1, [], 1).messages).toEqual([]);
  });

  test("segment ids become message ids, for scroll anchoring parity with typed chat", () => {
    const entry = toHistoryEntry("voice-y", 1, [{ id: "seg-1", text: "hi", fromAgent: false }], 1);
    expect(entry.messages[0]!.id).toBe("seg-1");
  });
});
