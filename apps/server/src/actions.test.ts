import { test, expect } from "bun:test";
import { buildCommand } from "./actions";

// ---------------------------------------------------------------------------
// restart
// ---------------------------------------------------------------------------
test("restart maps to rollout restart deployment", () => {
  expect(buildCommand({ kind: "restart", name: "memos", namespace: "default" }))
    .toEqual(["rollout", "restart", "deployment/memos", "-n", "default"]);
});

test("restart with statefulset kind", () => {
  expect(buildCommand({ kind: "restart", name: "pg", namespace: "default", resourceKind: "statefulset" }))
    .toEqual(["rollout", "restart", "statefulset/pg", "-n", "default"]);
});

test("restart with daemonset kind", () => {
  expect(buildCommand({ kind: "restart", name: "fluentd", namespace: "kube-system", resourceKind: "daemonset" }))
    .toEqual(["rollout", "restart", "daemonset/fluentd", "-n", "kube-system"]);
});

// ---------------------------------------------------------------------------
// scale
// ---------------------------------------------------------------------------
test("scale maps to scale --replicas", () => {
  expect(buildCommand({ kind: "scale", name: "web", namespace: "default", replicas: 3 }))
    .toEqual(["scale", "deployment/web", "--replicas=3", "-n", "default"]);
});

test("scale with statefulset kind", () => {
  expect(buildCommand({ kind: "scale", name: "pg", namespace: "default", replicas: 2, resourceKind: "statefulset" }))
    .toEqual(["scale", "statefulset/pg", "--replicas=2", "-n", "default"]);
});

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------
test("rollback maps to rollout undo deployment", () => {
  expect(buildCommand({ kind: "rollback", name: "memos", namespace: "default" }))
    .toEqual(["rollout", "undo", "deployment/memos", "-n", "default"]);
});

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------
test("pause maps to rollout pause deployment", () => {
  expect(buildCommand({ kind: "pause", name: "web", namespace: "default" }))
    .toEqual(["rollout", "pause", "deployment/web", "-n", "default"]);
});

test("resume maps to rollout resume deployment", () => {
  expect(buildCommand({ kind: "resume", name: "web", namespace: "default" }))
    .toEqual(["rollout", "resume", "deployment/web", "-n", "default"]);
});

// ---------------------------------------------------------------------------
// setEnv
// ---------------------------------------------------------------------------
test("setEnv maps to set env deployment with sorted key=value pairs", () => {
  // Swift sorts by key
  const result = buildCommand({
    kind: "setEnv",
    name: "memos",
    namespace: "default",
    env: { MEMOS_PORT: "5230", LOG_LEVEL: "info" },
  });
  expect(result).toEqual([
    "set", "env", "deployment/memos", "-n", "default",
    "LOG_LEVEL=info", "MEMOS_PORT=5230",
  ]);
});

// ---------------------------------------------------------------------------
// setImage
// ---------------------------------------------------------------------------
test("setImage maps to set image deployment container=image", () => {
  expect(buildCommand({
    kind: "setImage",
    name: "memos",
    namespace: "default",
    container: "memos",
    image: "neosmemo/memos:0.22.1",
    resourceKind: "deployment",
  })).toEqual(["set", "image", "deployment/memos", "memos=neosmemo/memos:0.22.1", "-n", "default"]);
});

test("setImage with statefulset kind", () => {
  expect(buildCommand({
    kind: "setImage",
    name: "pg",
    namespace: "default",
    container: "postgres",
    image: "postgres:16",
    resourceKind: "statefulset",
  })).toEqual(["set", "image", "statefulset/pg", "postgres=postgres:16", "-n", "default"]);
});

// ---------------------------------------------------------------------------
// setResources
// ---------------------------------------------------------------------------
test("setResources with requests and limits", () => {
  expect(buildCommand({
    kind: "setResources",
    name: "web",
    namespace: "default",
    container: "web",
    requests: "cpu=250m,memory=512Mi",
    limits: "cpu=500m,memory=1Gi",
    resourceKind: "deployment",
  })).toEqual([
    "set", "resources", "deployment/web",
    "-c", "web",
    "--requests=cpu=250m,memory=512Mi",
    "--limits=cpu=500m,memory=1Gi",
    "-n", "default",
  ]);
});

test("setResources with requests only (empty limits omitted)", () => {
  expect(buildCommand({
    kind: "setResources",
    name: "web",
    namespace: "default",
    container: "web",
    requests: "cpu=250m,memory=512Mi",
    limits: "",
    resourceKind: "deployment",
  })).toEqual([
    "set", "resources", "deployment/web",
    "-c", "web",
    "--requests=cpu=250m,memory=512Mi",
    "-n", "default",
  ]);
});

test("setResources with limits only (empty requests omitted)", () => {
  expect(buildCommand({
    kind: "setResources",
    name: "web",
    namespace: "default",
    container: "web",
    requests: "",
    limits: "cpu=500m,memory=1Gi",
    resourceKind: "deployment",
  })).toEqual([
    "set", "resources", "deployment/web",
    "-c", "web",
    "--limits=cpu=500m,memory=1Gi",
    "-n", "default",
  ]);
});

// ---------------------------------------------------------------------------
// deletePod
// ---------------------------------------------------------------------------
test("deletePod maps to delete pod <name> -n <ns>", () => {
  expect(buildCommand({ kind: "deletePod", pod: "memos-abc-xyz", namespace: "default" }))
    .toEqual(["delete", "pod", "memos-abc-xyz", "-n", "default"]);
});

// ---------------------------------------------------------------------------
// deleteWorkload
// ---------------------------------------------------------------------------
test("deleteWorkload maps to delete <kind> <name> -n <ns>", () => {
  expect(buildCommand({ kind: "deleteWorkload", name: "memos", namespace: "default", resourceKind: "deployment" }))
    .toEqual(["delete", "deployment", "memos", "-n", "default"]);
});

test("deleteWorkload with statefulset", () => {
  expect(buildCommand({ kind: "deleteWorkload", name: "pg", namespace: "default", resourceKind: "statefulset" }))
    .toEqual(["delete", "statefulset", "pg", "-n", "default"]);
});

// ---------------------------------------------------------------------------
// cordon / uncordon / drain
// ---------------------------------------------------------------------------
test("cordon maps to cordon <node>", () => {
  expect(buildCommand({ kind: "cordon", node: "worker-1" }))
    .toEqual(["cordon", "worker-1"]);
});

test("uncordon maps to uncordon <node>", () => {
  expect(buildCommand({ kind: "uncordon", node: "worker-1" }))
    .toEqual(["uncordon", "worker-1"]);
});

test("drain maps to drain with default options", () => {
  expect(buildCommand({ kind: "drain", node: "worker-1" }))
    .toEqual(["drain", "worker-1", "--ignore-daemonsets", "--delete-emptydir-data"]);
});

// ---------------------------------------------------------------------------
// suspendCronJob / resumeCronJob / triggerCronJob
// ---------------------------------------------------------------------------
test("suspendCronJob maps to patch cronjob suspend=true", () => {
  expect(buildCommand({ kind: "suspendCronJob", name: "backup", namespace: "default" }))
    .toEqual(["patch", "cronjob", "backup", "-n", "default", "--type=merge", "-p", '{"spec":{"suspend":true}}']);
});

test("resumeCronJob maps to patch cronjob suspend=false", () => {
  expect(buildCommand({ kind: "resumeCronJob", name: "backup", namespace: "default" }))
    .toEqual(["patch", "cronjob", "backup", "-n", "default", "--type=merge", "-p", '{"spec":{"suspend":false}}']);
});

test("triggerCronJob maps to create job --from=cronjob/<name>", () => {
  expect(buildCommand({ kind: "triggerCronJob", name: "backup", namespace: "default", pod: "backup-manual-run" }))
    .toEqual(["create", "job", "backup-manual-run", "--from=cronjob/backup", "-n", "default"]);
});

// ---------------------------------------------------------------------------
// createNamespace / deleteNamespace
// ---------------------------------------------------------------------------
test("createNamespace maps to create namespace", () => {
  expect(buildCommand({ kind: "createNamespace", name: "staging" }))
    .toEqual(["create", "namespace", "staging"]);
});

test("deleteNamespace maps to delete namespace", () => {
  expect(buildCommand({ kind: "deleteNamespace", name: "staging" }))
    .toEqual(["delete", "namespace", "staging"]);
});

// ---------------------------------------------------------------------------
// deleteResource
// ---------------------------------------------------------------------------
test("deleteResource service maps to delete service -n", () => {
  expect(buildCommand({ kind: "deleteResource", name: "my-svc", namespace: "default", resourceKind: "service" }))
    .toEqual(["delete", "service", "my-svc", "-n", "default"]);
});

test("deleteResource configmap", () => {
  expect(buildCommand({ kind: "deleteResource", name: "my-cm", namespace: "default", resourceKind: "configmap" }))
    .toEqual(["delete", "configmap", "my-cm", "-n", "default"]);
});

test("deleteResource secret", () => {
  expect(buildCommand({ kind: "deleteResource", name: "my-secret", namespace: "default", resourceKind: "secret" }))
    .toEqual(["delete", "secret", "my-secret", "-n", "default"]);
});

test("deleteResource pvc", () => {
  expect(buildCommand({ kind: "deleteResource", name: "my-pvc", namespace: "default", resourceKind: "pvc" }))
    .toEqual(["delete", "pvc", "my-pvc", "-n", "default"]);
});

test("deleteResource pv (cluster-scoped, no namespace)", () => {
  expect(buildCommand({ kind: "deleteResource", name: "my-pv", resourceKind: "pv" }))
    .toEqual(["delete", "pv", "my-pv"]);
});

test("deleteResource ingress", () => {
  expect(buildCommand({ kind: "deleteResource", name: "my-ing", namespace: "default", resourceKind: "ingress" }))
    .toEqual(["delete", "ingress", "my-ing", "-n", "default"]);
});

test("deleteResource clusterrole (cluster-scoped, no namespace)", () => {
  expect(buildCommand({ kind: "deleteResource", name: "my-role", resourceKind: "clusterrole" }))
    .toEqual(["delete", "clusterrole", "my-role"]);
});

test("deleteResource role (namespaced)", () => {
  expect(buildCommand({ kind: "deleteResource", name: "my-role", namespace: "default", resourceKind: "role" }))
    .toEqual(["delete", "role", "my-role", "-n", "default"]);
});

test("deleteResource rolebinding (namespaced)", () => {
  expect(buildCommand({ kind: "deleteResource", name: "my-rb", namespace: "default", resourceKind: "rolebinding" }))
    .toEqual(["delete", "rolebinding", "my-rb", "-n", "default"]);
});

test("deleteResource clusterrolebinding (cluster-scoped)", () => {
  expect(buildCommand({ kind: "deleteResource", name: "my-crb", resourceKind: "clusterrolebinding" }))
    .toEqual(["delete", "clusterrolebinding", "my-crb"]);
});

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------
test("command kind passes args through verbatim", () => {
  expect(buildCommand({ kind: "command", args: ["cnpg", "destroy", "pg-1", "-n", "default"] }))
    .toEqual(["cnpg", "destroy", "pg-1", "-n", "default"]);
});

test("command with get logs args", () => {
  expect(buildCommand({ kind: "command", args: ["logs", "memos-abc", "-n", "default"] }))
    .toEqual(["logs", "memos-abc", "-n", "default"]);
});

// ---------------------------------------------------------------------------
// purge — sentinel: throws PurgeActionError
// ---------------------------------------------------------------------------
test("purge throws PurgeActionError (not a kubectl command)", () => {
  expect(() => buildCommand({ kind: "purge", name: "memos", namespace: "default" }))
    .toThrow("purge");
});

// ---------------------------------------------------------------------------
// unknown kind
// ---------------------------------------------------------------------------
test("unknown kind throws", () => {
  expect(() => buildCommand({ kind: "unknownKind" as never }))
    .toThrow("unsupported action kind");
});

// ---------------------------------------------------------------------------
// target fallback: name ?? deployment
// ---------------------------------------------------------------------------
test("restart uses deployment field as fallback when name is absent", () => {
  expect(buildCommand({ kind: "restart", deployment: "old-api", namespace: "prod" }))
    .toEqual(["rollout", "restart", "deployment/old-api", "-n", "prod"]);
});
