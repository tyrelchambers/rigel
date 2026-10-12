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

  test("a typed cordon or uncordon matches itself across both of its commands", () => {
    const uncordon = { label: "Uncordon k3s-slave", kind: "uncordon", node: "k3s-slave" };
    expect(sameAction(uncordon, { ...uncordon, label: "go" })).toBe(true);
    expect(sameAction(uncordon, cmd(["uncordon", "k3s-slave"]))).toBe(false);
    expect(sameAction(uncordon, { ...uncordon, kind: "cordon" })).toBe(false);
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
  test("a queued uncordon shows its exact typed action as the block that approves it", () => {
    const uncordon = { label: "Uncordon k3s-slave", kind: "uncordon", node: "k3s-slave" };
    const out = pendingFixesContext([q({ suggestion: "Uncordon k3s-slave", action: uncordon })]);
    expect(out).toContain(`1. Uncordon k3s-slave: to approve, emit: ${JSON.stringify(uncordon)}`);
    expect(out).toMatch(/don't raise these unprompted/i);
    expect(out).not.toContain('"kind":"command"');
  });

  test("a queued restart uses the same typed format", () => {
    const out = pendingFixesContext([q({ suggestion: "Restart memos", action: restart("memos") })]);
    expect(out).toContain(`1. Restart memos: to approve, emit: ${JSON.stringify(restart("memos"))}`);
  });

  test("a queued fix PR shows its action without the file content or body", () => {
    const out = pendingFixesContext([
      q({ suggestion: "Open fix PR", action: { kind: "openFixPR", label: "Open fix PR", source: "memos", filePath: "apps/memos/deployment.yaml", content: "big", body: "long", title: "Bump memos" } }),
    ]);
    expect(out).toContain('1. Open fix PR: to approve, emit: {"kind":"openFixPR","label":"Open fix PR","source":"memos","filePath":"apps/memos/deployment.yaml","title":"Bump memos"}');
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

  test("labels non-runnable items instead of an approval block", () => {
    const out = pendingFixesContext([
      q({ suggestion: "Bump watcher memory", action: undefined }),
      q({ suggestion: "Drain it", action: { kind: "drain", label: "Drain" } }),
    ]);
    expect(out).toContain("1. Bump watcher memory: handle in Rigel (not runnable from chat)");
    expect(out).toContain("2. Drain it: handle in Rigel (not runnable from chat)");
  });
});
