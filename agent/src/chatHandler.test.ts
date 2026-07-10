import { describe, test, expect, vi } from "vitest";
import { routeChatReply } from "./chatHandler.js";
import type { SuggestedAction } from "./action.js";

describe("routeChatReply", () => {
  test("no action → reply unchanged, nothing executed", async () => {
    const execute = vi.fn();
    const out = await routeChatReply("Restarted api; pods healthy now.", execute);
    expect(out).toBe("Restarted api; pods healthy now.");
    expect(execute).not.toHaveBeenCalled();
  });

  test("a confirmed destructive action → executed through the guard, outcome appended", async () => {
    const execute = vi.fn(async (_a: SuggestedAction) => "✓ Ran: delete orphaned PVC");
    const text = 'Deleting the orphaned PVC now.\n```action\n{"kind":"command","args":["delete","pvc","data-0","-n","payments"],"destructive":true,"label":"delete orphaned PVC"}\n```';
    const out = await routeChatReply(text, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({ kind: "command", label: "delete orphaned PVC" });
    expect(out).toBe("Deleting the orphaned PVC now.\n\n✓ Ran: delete orphaned PVC");
    expect(out).not.toMatch(/```action/); // fence stripped from the texted reply
    expect(out).not.toMatch(/reply "yes"/i); // no second confirmation beat
  });

  test("an action with no surrounding prose → just the outcome", async () => {
    const execute = vi.fn(async (_a: SuggestedAction) => "✓ Ran: drain node-3");
    const text = '```action\n{"kind":"command","args":["drain","node-3"],"destructive":true,"label":"drain node-3"}\n```';
    expect(await routeChatReply(text, execute)).toBe("✓ Ran: drain node-3");
  });
});
