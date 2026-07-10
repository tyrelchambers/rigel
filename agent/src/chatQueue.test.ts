import { describe, expect, test } from "vitest";
import { pendingFixesContext, sameInvocations } from "./chatQueue.js";
import type { QueuedSuggestion } from "./state.js";

const restart = (dep: string, ns = "default") => ({ kind: "restart", deployment: dep, namespace: ns, label: `restart ${dep}` });
const cmd = (args: string[]) => ({ kind: "command", args, destructive: true, label: args.join(" ") });

function q(over: Partial<QueuedSuggestion>): QueuedSuggestion {
  return { at: "t", incident: "inc", suggestion: "s", reason: "r", ...over };
}

describe("sameInvocations", () => {
  test("a command action matches the typed action it is equivalent to", () => {
    // Loop queued a typed `restart`; the agent re-emits it as the raw kubectl command.
    expect(sameInvocations(restart("memos"), cmd(["rollout", "restart", "deployment/memos", "-n", "default"]))).toBe(true);
  });

  test("different targets do not match", () => {
    expect(sameInvocations(restart("memos"), cmd(["rollout", "restart", "deployment/api", "-n", "default"]))).toBe(false);
  });

  test("repo-fix actions never match (no kubectl invocation)", () => {
    const pr = { kind: "openFixPR", label: "open fix PR" };
    expect(sameInvocations(pr, pr)).toBe(false);
  });
});

describe("pendingFixesContext", () => {
  test("empty queue → empty string (nothing injected)", () => {
    expect(pendingFixesContext([])).toBe("");
  });

  test("renders a runnable command for an action-backed item", () => {
    const out = pendingFixesContext([q({ suggestion: "Restart memos", action: restart("memos") })]);
    expect(out).toContain("1. Restart memos — run: kubectl rollout restart deployment/memos -n default");
    expect(out).toMatch(/don't raise these unprompted/i);
  });

  test("labels non-runnable items instead of a command", () => {
    const out = pendingFixesContext([
      q({ suggestion: "Bump watcher memory", action: undefined }),
      q({ suggestion: "Patch the manifest", action: { kind: "openFixPR", label: "PR" } }),
    ]);
    expect(out).toContain("1. Bump watcher memory — handle in Rigel (not runnable from chat)");
    expect(out).toContain("2. Patch the manifest — opens a fix PR");
  });
});
