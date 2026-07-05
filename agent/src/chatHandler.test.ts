import { describe, test, expect, vi } from "vitest";
import { routeChatReply } from "./chatHandler.js";

describe("routeChatReply", () => {
  test("no action → reply unchanged", async () => {
    const enqueue = vi.fn();
    const out = await routeChatReply("Restarted api; pods healthy now.", enqueue);
    expect(out).toBe("Restarted api; pods healthy now.");
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("command action → queued + confirm line appended", async () => {
    const enqueue = vi.fn(async () => 1); // returns 1-based queue index
    const text = 'Payments PVC is orphaned. I would delete it.\n```action\n{"kind":"command","args":["delete","pvc","data-0","-n","payments"],"destructive":true,"label":"delete orphaned PVC"}\n```';
    const out = await routeChatReply(text, enqueue);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/reply "yes"/i);
    expect(out).not.toMatch(/```action/); // fence stripped from the texted reply
  });
});
