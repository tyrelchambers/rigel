import { describe, expect, test } from "vitest";
import { mergeSegments, toHistoryEntry } from "./voiceHistory";

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

describe("mergeSegments", () => {
  test("a sentence finalized in several segments becomes one message", () => {
    const entry = toHistoryEntry(
      "voice-1",
      1,
      [
        { id: "s1", text: "Can you update my", fromAgent: false },
        { id: "s2", text: "canada hires deployment", fromAgent: false },
        { id: "s3", text: "labels to job watch canada", fromAgent: false },
      ],
      1,
    );
    expect(entry.messages).toEqual([
      { id: "s1", role: "user", text: "Can you update my canada hires deployment labels to job watch canada" },
    ]);
  });

  test("a change of speaker ends the turn", () => {
    expect(
      mergeSegments([
        { id: "s1", text: "how is reddex", fromAgent: false },
        { id: "s2", text: "Reddex is healthy.", fromAgent: true },
        { id: "s3", text: "Three of three ready.", fromAgent: true },
        { id: "s4", text: "restart it", fromAgent: false },
      ]),
    ).toEqual([
      { id: "s1", text: "how is reddex", fromAgent: false },
      { id: "s2", text: "Reddex is healthy. Three of three ready.", fromAgent: true },
      { id: "s4", text: "restart it", fromAgent: false },
    ]);
  });

  test("blank segments neither render nor split a turn", () => {
    expect(
      mergeSegments([
        { id: "s1", text: "scale web", fromAgent: false },
        { id: "s2", text: "   ", fromAgent: false },
        { id: "s3", text: "to three", fromAgent: false },
      ]),
    ).toEqual([{ id: "s1", text: "scale web to three", fromAgent: false }]);
  });

  test("does not mutate the segments handed in", () => {
    const segments = [
      { id: "s1", text: "one", fromAgent: false },
      { id: "s2", text: "two", fromAgent: false },
    ];
    mergeSegments(segments);
    expect(segments.map((s) => s.text)).toEqual(["one", "two"]);
  });
});
