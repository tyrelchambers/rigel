import { test, expect } from "vitest";
import { buildApplyArgs } from "./install";
import { type HelmInstallRequest } from "./install";
import { buildHelmInstallCommands } from "@rigel/k8s/src/helm";

// ---------------------------------------------------------------------------
// kubectl apply -f - (manifest mode)
// ---------------------------------------------------------------------------
test("buildApplyArgs: apply -f - with context", () => {
  expect(buildApplyArgs("kind-test")).toEqual([
    "--context",
    "kind-test",
    "apply",
    "-f",
    "-",
  ]);
});

test("buildApplyArgs: apply -f - without context", () => {
  expect(buildApplyArgs(null)).toEqual(["apply", "-f", "-"]);
});

test("buildApplyArgs: server-side dry run appends --dry-run=server", () => {
  expect(buildApplyArgs("kind-test", true)).toEqual([
    "--context",
    "kind-test",
    "apply",
    "-f",
    "-",
    "--dry-run=server",
  ]);
});

test("buildApplyArgs: no dry-run flag unless requested", () => {
  expect(buildApplyArgs(null, false)).toEqual(["apply", "-f", "-"]);
});

// ---------------------------------------------------------------------------
// helm upgrade --install (helm mode via shared builder)
// ---------------------------------------------------------------------------
test("install request maps a repo source to the shared builder", () => {
  const req: HelmInstallRequest = {
    source: { kind: "repo", repoName: "sentry", repoURL: "https://sentry-kubernetes.github.io/charts", chart: "sentry", version: "31.7.1" },
    releaseName: "my-sentry",
    namespace: "apps",
    values: "user:\n  create: true\n",
  };
  const cmds = buildHelmInstallCommands(req.source, { releaseName: req.releaseName, namespace: req.namespace, valuesFile: "/tmp/v.yaml", context: "kind-test" });
  expect(cmds[2][0]).toBe("upgrade");
  expect(cmds[2]).toContain("sentry/sentry");
});
