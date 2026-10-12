import { describe, expect, test } from "vitest";
import { pendingFixesContext, sameAction } from "./chatQueue.js";
import type { QueuedSuggestion } from "./state.js";

const restart = (dep: string, ns = "default") => ({ kind: "restart", deployment: dep, namespace: ns, label: `restart ${dep}` });
const cmd = (args: string[]) => ({ kind: "command", args, destructive: true, label: args.join(" ") });

function q(over: Partial<QueuedSuggestion>): QueuedSuggestion {
  return { at: "t", incident: "inc", suggestion: "s", reason: "r", ...over };
}

describe("sameAction", () => {
  test("a command action matches the typed action it is equivalent to", () => {
    // Loop queued a typed `restart`; the agent re-emits it as the raw kubectl command.
    expect(sameAction(restart("memos"), cmd(["rollout", "restart", "deployment/memos", "-n", "default"]))).toBe(true);
  });

  test("different targets do not match", () => {
    expect(sameAction(restart("memos"), cmd(["rollout", "restart", "deployment/api", "-n", "default"]))).toBe(false);
  });

  test("fix PRs match on their source and file", () => {
    const pr = { kind: "openFixPR", label: "Open fix PR", source: "memos", filePath: "apps/memos/deployment.yaml", content: "x" };
    expect(sameAction(pr, { kind: "openFixPR", label: "approve it", source: "memos", filePath: "apps/memos/deployment.yaml" })).toBe(true);
    expect(sameAction(pr, { ...pr, filePath: "apps/memos/service.yaml" })).toBe(false);
    expect(sameAction(pr, { ...pr, source: "api" })).toBe(false);
    expect(sameAction({ kind: "openFixPR", label: "PR" }, { kind: "openFixPR", label: "PR" })).toBe(false);
    expect(sameAction(pr, cmd(["rollout", "restart", "deployment/memos"]))).toBe(false);
  });
});

describe("pendingFixesContext", () => {
  test("a queued fix PR shows the block that approves it", () => {
    const out = pendingFixesContext([
      q({ suggestion: "Open fix PR", action: { kind: "openFixPR", label: "Open fix PR", source: "memos", filePath: "apps/memos/deployment.yaml", content: "big", body: "long" } }),
    ]);
    expect(out).toContain('1. Open fix PR — opens a fix PR; to approve, emit: {"kind":"openFixPR","label":"Open fix PR","source":"memos","filePath":"apps/memos/deployment.yaml"}');
  });


  test("a fix PR already being opened is listed without an approval block", () => {
    const out = pendingFixesContext([
      q({ suggestion: "Bump memos", pending: true, action: { kind: "openFixPR", label: "Open fix PR", source: "memos", filePath: "apps/memos/deployment.yaml" } }),
    ]);
    expect(out).toContain("1. Bump memos: fix PR already being opened, nothing to approve");
    expect(out).not.toContain("emit:");
  });

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
    expect(out).toContain("2. Patch the manifest — opens a fix PR; to approve, emit:");
  });
});
