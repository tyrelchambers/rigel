import { describe, it, expect } from "vitest";
import { computeTrigger, commandRest } from "./composerTriggerLogic";
import type { MentionCandidate } from "@/panels/chat/mentions";

const MENTIONS: MentionCandidate[] = [
  { id: "dep-web", kind: "deployment", name: "web", namespace: "default", context: "Deployment web" },
  { id: "pod-web-abc", kind: "pod", name: "web-abc", namespace: "default", context: "Pod web-abc" },
  { id: "node-n1", kind: "node", name: "node1", context: "Node node1" },
];

describe("computeTrigger", () => {
  it("matches a leading / command trigger", () => {
    const t = computeTrigger("/log", 4, MENTIONS);
    expect(t?.kind).toBe("command");
    if (t?.kind === "command") {
      expect(t.query).toBe("log");
      expect(t.items.some((c) => c.name === "logs")).toBe(true);
    }
  });

  it("returns all commands for a bare slash", () => {
    const t = computeTrigger("/", 1, MENTIONS);
    expect(t?.kind).toBe("command");
    if (t?.kind === "command") {
      expect(t.query).toBe("");
      expect(t.items.length).toBeGreaterThan(0);
    }
  });

  it("matches a mid-text @ mention trigger", () => {
    const value = "restart @web";
    const t = computeTrigger(value, value.length, MENTIONS);
    expect(t?.kind).toBe("mention");
    if (t?.kind === "mention") {
      expect(t.query).toBe("web");
      expect(t.start).toBe(8); // index of "@"
      expect(t.items.some((c) => c.name === "web")).toBe(true);
    }
  });

  it("matches a leading @ mention trigger (start of string)", () => {
    const value = "@web";
    const t = computeTrigger(value, value.length, MENTIONS);
    expect(t?.kind).toBe("mention");
    if (t?.kind === "mention") {
      expect(t.start).toBe(0);
    }
  });

  it("does not trigger a command when whitespace precedes the caret", () => {
    // The leading-slash trigger requires no whitespace before the caret.
    expect(computeTrigger("/logs web", 9, MENTIONS)).toBeNull();
  });

  it("does not trigger a mention when the @ fragment contains whitespace", () => {
    // A space after the @-token closes the mention.
    expect(computeTrigger("@web ", 5, MENTIONS)).toBeNull();
  });

  it("does not trigger a mention when @ is not at a word boundary", () => {
    // "@" glued to a preceding non-space char (e.g. an email) is not a mention.
    expect(computeTrigger("foo@web", 7, MENTIONS)).toBeNull();
  });

  it("returns null when nothing matches (plain text)", () => {
    expect(computeTrigger("hello world", 11, MENTIONS)).toBeNull();
  });

  it("returns null when an @ fragment matches no candidate", () => {
    expect(computeTrigger("@zzzzz", 6, MENTIONS)).toBeNull();
  });
});

describe("commandRest", () => {
  it("returns the text after the first space", () => {
    expect(commandRest("/logs web")).toBe("web");
  });

  it("returns text after the first space only", () => {
    expect(commandRest("/restart web frontend")).toBe("web frontend");
  });

  it("returns empty string when there is no space", () => {
    expect(commandRest("/logs")).toBe("");
  });

  it("returns empty string for an empty value", () => {
    expect(commandRest("")).toBe("");
  });
});
