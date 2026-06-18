import { expect, test } from "vitest";
import { editModelFor, diffDeployment } from "./deploymentDisplay";
import type { Deployment } from "./types";

function dep(): Deployment {
  return {
    metadata: { name: "web", namespace: "default", uid: "u1" },
    spec: {
      replicas: 2,
      template: {
        spec: {
          containers: [
            {
              name: "app",
              image: "nginx:1.25",
              env: [
                { name: "LOG_LEVEL", value: "info" },
                { name: "DB_PASS", valueFrom: { secretKeyRef: { name: "db", key: "pass" } } },
              ],
              resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "256Mi" } },
            },
          ],
          imagePullSecrets: [{ name: "ghcr-secret" }],
        },
      },
    },
  };
}

test("editModelFor splits plain vs ref env and reads replicas/image/resources", () => {
  const m = editModelFor(dep());
  expect(m.replicas).toBe(2);
  expect(m.containers[0].name).toBe("app");
  expect(m.containers[0].image).toBe("nginx:1.25");
  expect(m.containers[0].cpuReq).toBe("100m");
  expect(m.containers[0].memLim).toBe("256Mi");
  expect(m.containers[0].cpuLim).toBe("");
  expect(m.containers[0].env).toEqual([{ id: "LOG_LEVEL", key: "LOG_LEVEL", value: "info" }]);
  expect(m.containers[0].envRefs).toEqual([
    { id: "DB_PASS", name: "DB_PASS", source: "secret", resourceName: "db", key: "pass" },
  ]);
  expect(m.containers[0].otherRefKeys).toEqual([]);
  expect(m.imagePullSecrets).toEqual(["ghcr-secret"]);
});

test("diffDeployment returns empty when nothing changed", () => {
  const original = dep();
  expect(diffDeployment(original, editModelFor(original))).toEqual([]);
});

test("diffDeployment emits scale when replicas change", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.replicas = 5;
  expect(diffDeployment(original, edit)).toEqual([
    { kind: "scale", name: "web", namespace: "default", replicas: 5, label: "Scale web to 5 replicas" },
  ]);
});

test("diffDeployment emits setImage when image changes", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.containers[0].image = "nginx:1.27";
  expect(diffDeployment(original, edit)).toEqual([
    { kind: "setImage", name: "web", namespace: "default", container: "app", image: "nginx:1.27", label: "Set app image to nginx:1.27" },
  ]);
});

test("diffDeployment emits setResources when requests/limits change", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.containers[0].cpuLim = "500m";
  expect(diffDeployment(original, edit)).toEqual([
    {
      kind: "setResources", name: "web", namespace: "default", container: "app",
      limits: "cpu=500m,memory=256Mi",
      label: "Update app resources",
    },
  ]);
});

test("diffDeployment emits setEnv with adds, edits, and removals", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.containers[0].env = [
    { id: "LOG_LEVEL", key: "LOG_LEVEL", value: "debug" }, // modified
    { id: "NEW", key: "NEW", value: "1" },                 // added
  ];                                       // (LOG_LEVEL kept, original had only LOG_LEVEL plain)
  edit.containers[0].envRefs = [];          // removed the DB_PASS ref var
  expect(diffDeployment(original, edit)).toEqual([
    {
      kind: "setEnv", name: "web", namespace: "default", container: "app",
      env: { LOG_LEVEL: "debug", NEW: "1" },
      unsetEnv: ["DB_PASS"],
      label: "Update app environment",
    },
  ]);
});

test("diffDeployment emits setEnv removal when a plain var is deleted", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.containers[0].env = [] as import("./deploymentDisplay").EnvEdit[]; // dropped LOG_LEVEL; ref DB_PASS still kept
  const actions = diffDeployment(original, edit);
  expect(actions).toContainEqual(
    expect.objectContaining({ kind: "setEnv", unsetEnv: ["LOG_LEVEL"] }),
  );
});

test("diffDeployment batches multiple changed dimensions in order", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.replicas = 3;
  edit.containers[0].image = "nginx:1.27";
  const kinds = diffDeployment(original, edit).map((a) => a.kind);
  expect(kinds).toEqual(["scale", "setImage"]);
});

test("diffDeployment ignores a cleared resource field (cannot remove via kubectl set resources)", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.containers[0].cpuReq = ""; // clear CPU request
  edit.containers[0].memReq = ""; // clear memory request
  expect(diffDeployment(original, edit).filter((a) => a.kind === "setResources")).toEqual([]);
});

test("diffDeployment setResources includes both flags when both change to non-empty values", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.containers[0].cpuReq = "200m"; // memReq stays 128Mi → requests=cpu=200m,memory=128Mi
  edit.containers[0].memLim = "512Mi"; // limits=memory=512Mi (cpuLim still "")
  expect(diffDeployment(original, edit)).toEqual([
    {
      kind: "setResources", name: "web", namespace: "default", container: "app",
      requests: "cpu=200m,memory=128Mi", limits: "memory=512Mi",
      label: "Update app resources",
    },
  ]);
});

test("diffDeployment emits setImagePullSecrets when the list changes", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.imagePullSecrets = ["ghcr-secret", "dockerhub"];
  expect(diffDeployment(original, edit)).toEqual([
    {
      kind: "setImagePullSecrets", name: "web", namespace: "default",
      imagePullSecrets: ["ghcr-secret", "dockerhub"],
      label: "Set image pull secrets: ghcr-secret, dockerhub",
    },
  ]);
});

test("diffDeployment ignores image-pull-secret reordering (set comparison)", () => {
  const original = dep();
  const edit = editModelFor(original); // ["ghcr-secret"]
  edit.imagePullSecrets = ["ghcr-secret"];
  expect(diffDeployment(original, edit)).toEqual([]);
});

test("diffDeployment emits a clear label when image pull secrets are removed", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.imagePullSecrets = [];
  expect(diffDeployment(original, edit)).toEqual([
    { kind: "setImagePullSecrets", name: "web", namespace: "default", imagePullSecrets: [], label: "Clear image pull secrets" },
  ]);
});

test("diffDeployment emits setEnvRef when a new secret ref is added", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.containers[0].envRefs.push({ id: "API_KEY", name: "API_KEY", source: "secret", resourceName: "api", key: "key" });
  expect(diffDeployment(original, edit)).toEqual([
    {
      kind: "setEnvRef", name: "web", namespace: "default", container: "app",
      envRefs: [{ name: "API_KEY", source: "secret", resourceName: "api", key: "key" }],
      label: "Reference secrets/config in app environment",
    },
  ]);
});

test("diffDeployment skips incomplete env ref rows", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.containers[0].envRefs.push({ id: "X", name: "X", source: "secret", resourceName: "", key: "" });
  expect(diffDeployment(original, edit)).toEqual([]);
});

test("diffDeployment unsets an env var when its ref is removed", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.containers[0].envRefs = []; // removes DB_PASS (a secretKeyRef)
  expect(diffDeployment(original, edit)).toEqual([
    {
      kind: "setEnv", name: "web", namespace: "default", container: "app",
      unsetEnv: ["DB_PASS"], label: "Update app environment",
    },
  ]);
});

test("diffDeployment converting a plain var to a ref unsets then setEnvRefs, in order", () => {
  const original = dep();
  const edit = editModelFor(original);
  // move LOG_LEVEL from plain to a configmap ref
  edit.containers[0].env = [];
  edit.containers[0].envRefs.push({ id: "LOG_LEVEL", name: "LOG_LEVEL", source: "configMap", resourceName: "cfg", key: "level" });
  expect(diffDeployment(original, edit)).toEqual([
    { kind: "setEnv", name: "web", namespace: "default", container: "app", unsetEnv: ["LOG_LEVEL"], label: "Update app environment" },
    {
      kind: "setEnvRef", name: "web", namespace: "default", container: "app",
      envRefs: [{ name: "LOG_LEVEL", source: "configMap", resourceName: "cfg", key: "level" }],
      label: "Reference secrets/config in app environment",
    },
  ]);
});
