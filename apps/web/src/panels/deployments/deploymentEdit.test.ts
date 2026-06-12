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
  expect(m.containers[0].env).toEqual([{ key: "LOG_LEVEL", value: "info" }]);
  expect(m.containers[0].refEnvKeys).toEqual(["DB_PASS"]);
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
      requests: "cpu=100m,memory=128Mi", limits: "cpu=500m,memory=256Mi",
      label: "Update app resources",
    },
  ]);
});

test("diffDeployment emits setEnv with adds, edits, and removals", () => {
  const original = dep();
  const edit = editModelFor(original);
  edit.containers[0].env = [
    { key: "LOG_LEVEL", value: "debug" }, // modified
    { key: "NEW", value: "1" },           // added
  ];                                       // (LOG_LEVEL kept, original had only LOG_LEVEL plain)
  edit.containers[0].refEnvKeys = [];      // removed the DB_PASS ref var
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
  edit.containers[0].env = []; // dropped LOG_LEVEL; ref DB_PASS still kept
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
