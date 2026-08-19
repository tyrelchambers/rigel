import { describe, it, expect } from "vitest";
import {
  AI_ACTIONS_CONFIGMAP,
  AI_ACTIONS_DATA_KEY,
  AI_ACTIONS_MAX,
  AI_ACTIONS_MAX_BYTES,
  AI_ACTION_COMMAND_MAX,
  AI_ACTION_DETAIL_MAX,
  AI_ACTION_TRIGGER_MAX,
  AI_ACTION_TRUNCATED_MARKER,
  aiActionsConfigMapJSON,
  truncateForLedger,
  appendAiAction,
  buildAiActionEntry,
  parseAiActions,
  summarizeActionDetail,
  type AiActionEntry,
  type AiActionSubject,
} from "./aiActionLedger";
import { LEDGER_LABEL_KEY } from "./applyBatch";
import type { SuggestedAction } from "./actionBlocks";

/** The chat wire type must stay assignable to the ledger's subject. */
const suggestedIsSubject = (a: SuggestedAction): AiActionSubject => a;

const entry = (over: Partial<AiActionEntry> = {}): AiActionEntry => ({
  id: "id-1",
  at: "2026-08-17T00:00:00.000Z",
  source: "chat",
  kind: "Restarted",
  target: { kind: "Deployment", name: "api", namespace: "default" },
  command: "kubectl rollout restart deployment/api -n default",
  outcome: "success",
  ...over,
});

describe("buildAiActionEntry", () => {
  it("accepts a SuggestedAction as its subject", () => {
    const action: SuggestedAction = { label: "Restart api", kind: "restart", name: "api", replicas: 1 };
    expect(suggestedIsSubject(action).kind).toBe("restart");
  });

  it("maps a scale action to its target, command and outcome", () => {
    const built = buildAiActionEntry({
      action: { kind: "scale", label: "Scale api to 3", name: "api", namespace: "prod" },
      source: "chat",
      command: "kubectl scale deployment/api --replicas=3 -n prod",
      outcome: "success",
      id: "abc",
      at: "2026-08-17T10:00:00.000Z",
    });
    expect(built).toEqual({
      id: "abc",
      at: "2026-08-17T10:00:00.000Z",
      source: "chat",
      kind: "Scaled",
      target: { kind: "Deployment", name: "api", namespace: "prod" },
      command: "kubectl scale deployment/api --replicas=3 -n prod",
      trigger: "Scale api to 3",
      outcome: "success",
    });
  });

  it("uses the workload kind for restart on a statefulset", () => {
    const built = buildAiActionEntry({
      action: { kind: "restart", name: "db", namespace: "data", resourceKind: "statefulset" },
      source: "chat",
      command: "kubectl rollout restart statefulset/db -n data",
      outcome: "success",
    });
    expect(built.kind).toBe("Restarted");
    expect(built.target).toEqual({ kind: "statefulset", name: "db", namespace: "data" });
  });

  it("targets the pod for deletePod, defaulting the namespace", () => {
    const built = buildAiActionEntry({
      action: { kind: "deletePod", pod: "api-abc" },
      source: "voice",
      command: "kubectl delete pod api-abc",
      outcome: "success",
    });
    expect(built.source).toBe("voice");
    expect(built.kind).toBe("Deleted");
    expect(built.target).toEqual({ kind: "Pod", name: "api-abc", namespace: "default" });
  });

  it("targets the node for cordon and leaves the namespace empty", () => {
    const built = buildAiActionEntry({
      action: { kind: "cordon", node: "worker-1" },
      source: "chat",
      command: "kubectl cordon worker-1",
      outcome: "success",
    });
    expect(built.kind).toBe("Cordoned");
    expect(built.target).toEqual({ kind: "Node", name: "worker-1", namespace: "" });
  });

  it("targets the namespace itself for deleteNamespace", () => {
    const built = buildAiActionEntry({
      action: { kind: "deleteNamespace", name: "scratch" },
      source: "chat",
      command: "kubectl delete namespace scratch",
      outcome: "success",
    });
    expect(built.target).toEqual({ kind: "Namespace", name: "scratch", namespace: "" });
  });

  it("targets the cronjob for triggerCronJob, not the generated job name", () => {
    const built = buildAiActionEntry({
      action: { kind: "triggerCronJob", name: "nightly", pod: "nightly-manual-1", namespace: "ops" },
      source: "chat",
      command: "kubectl create job nightly-manual-1 --from=cronjob/nightly -n ops",
      outcome: "success",
    });
    expect(built.kind).toBe("Triggered");
    expect(built.target).toEqual({ kind: "CronJob", name: "nightly", namespace: "ops" });
  });

  it("uses the deleteResource resourceKind as the target kind", () => {
    const built = buildAiActionEntry({
      action: { kind: "deleteResource", name: "web-tls", namespace: "web", resourceKind: "secret" },
      source: "chat",
      command: "kubectl delete secret web-tls -n web",
      outcome: "success",
    });
    expect(built.target).toEqual({ kind: "secret", name: "web-tls", namespace: "web" });
  });

  it("falls back to the raw action kind for a kind with no label", () => {
    const built = buildAiActionEntry({
      action: { kind: "command" },
      source: "chat",
      command: "kubectl get pods",
      outcome: "success",
    });
    expect(built.kind).toBe("Ran command");
  });

  it("records a failure with its detail", () => {
    const built = buildAiActionEntry({
      action: { kind: "restart", name: "api", namespace: "default" },
      source: "chat",
      command: "kubectl rollout restart deployment/api -n default",
      outcome: "failure",
      detail: 'Error from server (NotFound): deployments.apps "api" not found',
    });
    expect(built.outcome).toBe("failure");
    expect(built.detail).toBe('Error from server (NotFound): deployments.apps "api" not found');
  });

  it("prefers an explicit trigger over the action label", () => {
    const built = buildAiActionEntry({
      action: { kind: "restart", label: "Restart api", name: "api" },
      source: "voice",
      command: "kubectl rollout restart deployment/api",
      outcome: "success",
      trigger: "restart the api deployment",
    });
    expect(built.trigger).toBe("restart the api deployment");
  });

  it("mints a uuid and a timestamp when neither is supplied", () => {
    const built = buildAiActionEntry({
      action: { kind: "restart", name: "api" },
      source: "chat",
      command: "kubectl rollout restart deployment/api",
      outcome: "success",
    });
    expect(built.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(built.at))).toBe(false);
  });

  it("caps a pathological command and marks it as truncated", () => {
    const built = buildAiActionEntry({
      action: { kind: "setEnv", name: "api", namespace: "default" },
      source: "chat",
      command: `kubectl set env deployment/api BLOB=${"x".repeat(50_000)} -n default`,
      outcome: "success",
    });
    expect(built.command).toHaveLength(AI_ACTION_COMMAND_MAX);
    expect(built.command.endsWith(AI_ACTION_TRUNCATED_MARKER)).toBe(true);
    expect(built.command.startsWith("kubectl set env deployment/api BLOB=")).toBe(true);
  });

  it("leaves a command that fits the cap untouched", () => {
    const command = `kubectl set env deployment/api BLOB=${"x".repeat(AI_ACTION_COMMAND_MAX - 40)}`;
    const built = buildAiActionEntry({
      action: { kind: "setEnv", name: "api" },
      source: "chat",
      command,
      outcome: "success",
    });
    expect(built.command).toBe(command);
    expect(built.command).not.toContain(AI_ACTION_TRUNCATED_MARKER);
  });

  it("caps a pathological trigger and detail with the same marker", () => {
    const built = buildAiActionEntry({
      action: { kind: "restart", name: "api" },
      source: "voice",
      command: "kubectl rollout restart deployment/api",
      outcome: "failure",
      trigger: "t".repeat(5_000),
      detail: "d".repeat(5_000),
    });
    expect(built.trigger).toHaveLength(AI_ACTION_TRIGGER_MAX);
    expect(built.trigger!.endsWith(AI_ACTION_TRUNCATED_MARKER)).toBe(true);
    expect(built.detail).toHaveLength(AI_ACTION_DETAIL_MAX);
    expect(built.detail!.endsWith(AI_ACTION_TRUNCATED_MARKER)).toBe(true);
  });

  it("omits trigger and detail rather than storing empty strings", () => {
    const built = buildAiActionEntry({
      action: { kind: "restart", name: "api", label: "  " },
      source: "chat",
      command: "kubectl rollout restart deployment/api",
      outcome: "success",
      detail: "   ",
    });
    expect(built.trigger).toBeUndefined();
    expect(built.detail).toBeUndefined();
  });
});

describe("appendAiAction", () => {
  it("prepends the newest entry", () => {
    const list = [entry({ id: "old" })];
    expect(appendAiAction(list, entry({ id: "new" })).map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("does not mutate the input list", () => {
    const list = [entry({ id: "old" })];
    appendAiAction(list, entry({ id: "new" }));
    expect(list.map((e) => e.id)).toEqual(["old"]);
  });

  it("caps the ring buffer at AI_ACTIONS_MAX, dropping the oldest", () => {
    let list: AiActionEntry[] = [];
    for (let i = 0; i < AI_ACTIONS_MAX + 25; i++) list = appendAiAction(list, entry({ id: `e${i}` }));
    expect(list).toHaveLength(AI_ACTIONS_MAX);
    expect(list[0]!.id).toBe(`e${AI_ACTIONS_MAX + 24}`);
    expect(list[AI_ACTIONS_MAX - 1]!.id).toBe(`e${25}`);
  });

  it("honours an explicit cap", () => {
    const list = appendAiAction([entry({ id: "a" }), entry({ id: "b" })], entry({ id: "c" }), 2);
    expect(list.map((e) => e.id)).toEqual(["c", "a"]);
  });

  it("keeps a full ring buffer of ordinary entries, well inside the byte budget", () => {
    let list: AiActionEntry[] = [];
    for (let i = 0; i < AI_ACTIONS_MAX; i++) list = appendAiAction(list, entry({ id: `e${i}` }));
    expect(list).toHaveLength(AI_ACTIONS_MAX);
    expect(JSON.stringify(list).length).toBeLessThan(AI_ACTIONS_MAX_BYTES / 2);
  });

  it("keeps a long history of maximally capped entries inside the byte budget", () => {
    const fat = (id: string): AiActionEntry =>
      entry({
        id,
        command: truncateForLedger("k".repeat(5_000), AI_ACTION_COMMAND_MAX),
        trigger: truncateForLedger("t".repeat(5_000), AI_ACTION_TRIGGER_MAX),
        detail: truncateForLedger("d".repeat(5_000), AI_ACTION_DETAIL_MAX),
      });
    let list: AiActionEntry[] = [];
    for (let i = 0; i < AI_ACTIONS_MAX; i++) list = appendAiAction(list, fat(`e${i}`));
    expect(list.length).toBeGreaterThanOrEqual(100);
    expect(list.length).toBeLessThanOrEqual(AI_ACTIONS_MAX);
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(AI_ACTIONS_MAX_BYTES);
  });

  it("drops the oldest entries when the serialized list exceeds the byte budget", () => {
    const bytes = JSON.stringify([entry({ id: "a" })]).length * 3;
    let list: AiActionEntry[] = [];
    for (let i = 0; i < 10; i++) list = appendAiAction(list, entry({ id: `e${i}` }), 10, bytes);
    expect(list.length).toBeLessThan(10);
    expect(list[0]!.id).toBe("e9");
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(bytes);
  });

  it("keeps the newest entry even when it alone exceeds the byte budget", () => {
    const list = appendAiAction([entry({ id: "old" })], entry({ id: "new" }), 10, 1);
    expect(list.map((e) => e.id)).toEqual(["new"]);
  });
});

describe("truncateForLedger", () => {
  it("returns a value at or under the cap unchanged", () => {
    expect(truncateForLedger("kubectl get pods", 100)).toBe("kubectl get pods");
    expect(truncateForLedger("abcde", 5)).toBe("abcde");
  });

  it("never exceeds the cap, even when the cap is shorter than the marker", () => {
    expect(truncateForLedger("x".repeat(50), 10)).toHaveLength(10);
    expect(truncateForLedger("x".repeat(50), 3)).toHaveLength(3);
    expect(truncateForLedger("x".repeat(50), 0)).toBe("");
  });
});

describe("parseAiActions", () => {
  it("returns the stored entries", () => {
    expect(parseAiActions(JSON.stringify([entry({ id: "x" })]))).toEqual([entry({ id: "x" })]);
  });

  it("returns an empty list for missing, malformed or non-array data", () => {
    expect(parseAiActions(undefined)).toEqual([]);
    expect(parseAiActions(null)).toEqual([]);
    expect(parseAiActions("")).toEqual([]);
    expect(parseAiActions("{not json")).toEqual([]);
    expect(parseAiActions('{"a":1}')).toEqual([]);
  });
});

describe("aiActionsConfigMapJSON", () => {
  it("builds a labeled ConfigMap holding the entries under log.json", () => {
    const cm = JSON.parse(aiActionsConfigMapJSON("rigel", [entry({ id: "x" })])) as {
      apiVersion: string;
      kind: string;
      metadata: { name: string; namespace: string; labels: Record<string, string> };
      data: Record<string, string>;
    };
    expect(cm.apiVersion).toBe("v1");
    expect(cm.kind).toBe("ConfigMap");
    expect(cm.metadata.name).toBe(AI_ACTIONS_CONFIGMAP);
    expect(cm.metadata.namespace).toBe("rigel");
    expect(cm.metadata.labels[LEDGER_LABEL_KEY]).toBe("ai-actions");
    expect(parseAiActions(cm.data[AI_ACTIONS_DATA_KEY])).toEqual([entry({ id: "x" })]);
  });

  it("round-trips through parseAiActions", () => {
    const entries = [entry({ id: "a" }), entry({ id: "b" })];
    const cm = JSON.parse(aiActionsConfigMapJSON("default", entries)) as { data: Record<string, string> };
    expect(parseAiActions(cm.data[AI_ACTIONS_DATA_KEY])).toEqual(entries);
  });
});

describe("summarizeActionDetail", () => {
  it("summarizes a success from stdout", () => {
    expect(summarizeActionDetail("success", "deployment.apps/api restarted\n", "")).toBe(
      "deployment.apps/api restarted",
    );
  });

  it("summarizes a failure from stderr even when stdout has content", () => {
    expect(summarizeActionDetail("failure", "partial\n", "Error from server: nope\n")).toBe(
      "Error from server: nope",
    );
  });

  it("falls through to the other stream when the preferred one is blank", () => {
    expect(summarizeActionDetail("success", "   \n", "Warning: deprecated")).toBe("Warning: deprecated");
    expect(summarizeActionDetail("failure", "only stdout", "")).toBe("only stdout");
  });

  it("skips leading blank lines and returns the first content line", () => {
    expect(summarizeActionDetail("success", "\n\n  done\nmore\n", "")).toBe("done");
  });

  it("truncates a very long line and says so", () => {
    const long = "x".repeat(500);
    const out = summarizeActionDetail("failure", "", long)!;
    expect(out).toHaveLength(AI_ACTION_DETAIL_MAX);
    expect(out.endsWith(AI_ACTION_TRUNCATED_MARKER)).toBe(true);
  });

  it("returns undefined when both streams are empty", () => {
    expect(summarizeActionDetail("success", "", "")).toBeUndefined();
    expect(summarizeActionDetail("success", "  \n \n", "\n")).toBeUndefined();
  });
});
