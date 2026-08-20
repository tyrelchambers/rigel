import { describe, expect, test } from "vitest";
import { mergeSegments } from "./voiceTurns";

describe("mergeSegments", () => {
  test("a sentence finalized in several segments becomes one turn", () => {
    expect(
      mergeSegments([
        { id: "s1", text: "Can you update my", fromAgent: false },
        { id: "s2", text: "canada hires deployment", fromAgent: false },
        { id: "s3", text: "labels to job watch canada", fromAgent: false },
      ]),
    ).toEqual([
      { id: "s1", text: "Can you update my canada hires deployment labels to job watch canada", fromAgent: false },
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
