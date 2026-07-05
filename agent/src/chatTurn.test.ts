import { describe, test, expect } from "vitest";
import { chatSystemPrompt, chatHookSettings } from "./chatTurn.js";

describe("chatTurn config", () => {
  test("hook settings register a PreToolUse Bash matcher", () => {
    const s = JSON.parse(chatHookSettings());
    expect(s.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(s.hooks.PreToolUse[0].hooks[0].type).toBe("command");
  });
  test("system prompt tells the model it can act and must confirm destructive", () => {
    const p = chatSystemPrompt();
    expect(p).toMatch(/reversible/i);
    expect(p).toMatch(/destructive/i);
    expect(p).toMatch(/action block/i);
  });
});
