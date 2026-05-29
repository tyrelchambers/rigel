import { describe, expect, test } from "vitest";
import { backupTarget, parseActions, toKubectlInvocations } from "./action.js";

describe("parseActions", () => {
  test("parses a single fenced action object", () => {
    const text = [
      "I'll restart the deployment.",
      "```action",
      '{"label":"Restart memos","kind":"restart","deployment":"memos","namespace":"default"}',
      "```",
    ].join("\n");
    const actions = parseActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      label: "Restart memos",
      kind: "restart",
      deployment: "memos",
      namespace: "default",
    });
  });

  test("parses an array of actions in one fence", () => {
    const text = [
      "```action",
      '[{"label":"a","kind":"restart","deployment":"x","namespace":"default"},',
      ' {"label":"b","kind":"cordon","node":"node-1"}]',
      "```",
    ].join("\n");
    const actions = parseActions(text);
    expect(actions).toHaveLength(2);
    expect(actions[1]).toMatchObject({ kind: "cordon", node: "node-1" });
  });

  test("ignores non-action code fences", () => {
    const text = ["```bash", "kubectl get pods", "```"].join("\n");
    expect(parseActions(text)).toEqual([]);
  });

  test("drops an unterminated trailing action fence (mid-stream safety)", () => {
    const text = ["prose", "```action", '{"label":"x","kind":"restart"'].join("\n");
    expect(parseActions(text)).toEqual([]);
  });

  test("returns empty when there are no fences", () => {
    expect(parseActions("just prose, nothing to do")).toEqual([]);
  });

  test("decodes replicas and env fields", () => {
    const text = [
      "```action",
      '{"label":"scale","kind":"scale","deployment":"api","namespace":"prod","replicas":3}',
      "```",
      "```action",
      '{"label":"env","kind":"setEnv","deployment":"api","namespace":"prod","env":{"LOG":"debug"}}',
      "```",
    ].join("\n");
    const actions = parseActions(text);
    expect(actions[0]?.replicas).toBe(3);
    expect(actions[1]?.env).toEqual({ LOG: "debug" });
  });
});

describe("toKubectlInvocations", () => {
  test("restart → rollout restart deployment", () => {
    expect(
      toKubectlInvocations({ label: "", kind: "restart", deployment: "memos", namespace: "default" }),
    ).toEqual([["rollout", "restart", "deployment/memos", "-n", "default"]]);
  });

  test("rollback → rollout undo deployment", () => {
    expect(
      toKubectlInvocations({ label: "", kind: "rollback", deployment: "memos", namespace: "default" }),
    ).toEqual([["rollout", "undo", "deployment/memos", "-n", "default"]]);
  });

  test("scale → scale deployment with replicas", () => {
    expect(
      toKubectlInvocations({ label: "", kind: "scale", deployment: "api", namespace: "prod", replicas: 3 }),
    ).toEqual([["scale", "deployment/api", "--replicas=3", "-n", "prod"]]);
  });

  test("setEnv → set env with sorted KEY=VALUE pairs", () => {
    expect(
      toKubectlInvocations({
        label: "",
        kind: "setEnv",
        deployment: "api",
        namespace: "prod",
        env: { B: "2", A: "1" },
      }),
    ).toEqual([["set", "env", "deployment/api", "-n", "prod", "A=1", "B=2"]]);
  });

  test("deletePod → delete pod", () => {
    expect(
      toKubectlInvocations({ label: "", kind: "deletePod", pod: "memos-abc", namespace: "default" }),
    ).toEqual([["delete", "pod", "memos-abc", "-n", "default"]]);
  });

  test("cordon → cordon node", () => {
    expect(toKubectlInvocations({ label: "", kind: "cordon", node: "node-1" })).toEqual([
      ["cordon", "node-1"],
    ]);
  });

  test("uncordon → uncordon node", () => {
    expect(toKubectlInvocations({ label: "", kind: "uncordon", node: "node-1" })).toEqual([
      ["uncordon", "node-1"],
    ]);
  });

  test("namespace defaults to 'default' when omitted", () => {
    expect(
      toKubectlInvocations({ label: "", kind: "restart", deployment: "memos" }),
    ).toEqual([["rollout", "restart", "deployment/memos", "-n", "default"]]);
  });

  test("throws on a kind with missing required target", () => {
    expect(() => toKubectlInvocations({ label: "", kind: "restart" })).toThrow();
    expect(() => toKubectlInvocations({ label: "", kind: "scale", deployment: "api" })).toThrow();
    expect(() => toKubectlInvocations({ label: "", kind: "cordon" })).toThrow();
  });

  test("throws on an unsupported (non-executable) kind", () => {
    expect(() => toKubectlInvocations({ label: "", kind: "deleteNamespace", namespace: "x" })).toThrow();
  });
});

describe("backupTarget", () => {
  test("deployment mutations snapshot the deployment", () => {
    for (const kind of ["restart", "scale", "setEnv", "rollback"]) {
      expect(backupTarget({ label: "", kind, deployment: "api", namespace: "prod" })).toEqual({
        kind: "deployment",
        name: "api",
        namespace: "prod",
      });
    }
  });

  test("deletePod snapshots the pod", () => {
    expect(backupTarget({ label: "", kind: "deletePod", pod: "api-1", namespace: "prod" })).toEqual({
      kind: "pod",
      name: "api-1",
      namespace: "prod",
    });
  });

  test("node ops snapshot the cluster-scoped node (no namespace)", () => {
    expect(backupTarget({ label: "", kind: "cordon", node: "node-1" })).toEqual({
      kind: "node",
      name: "node-1",
      namespace: null,
    });
  });

  test("throws on an unsupported kind", () => {
    expect(() => backupTarget({ label: "", kind: "deleteNamespace", namespace: "x" })).toThrow();
  });
});
