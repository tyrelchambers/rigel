import { test, expect } from "bun:test";
import { buildApplyArgs, buildHelmArgs, type HelmInstallRequest } from "./install";

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

// ---------------------------------------------------------------------------
// helm upgrade --install (helm mode)
// ---------------------------------------------------------------------------
const baseReq: HelmInstallRequest = {
  repoName: "sentry",
  repoURL: "https://sentry-kubernetes.github.io/charts",
  chart: "sentry",
  version: "31.7.1",
  releaseName: "my-sentry",
  namespace: "apps",
  values: "user:\n  create: true\n",
};

test("buildHelmArgs: repo add / update sequence", () => {
  const args = buildHelmArgs(baseReq, "kind-test", "/tmp/values.yaml");
  expect(args.repoAdd).toEqual([
    "repo",
    "add",
    "sentry",
    "https://sentry-kubernetes.github.io/charts",
  ]);
  expect(args.repoUpdate).toEqual(["repo", "update", "sentry"]);
});

test("buildHelmArgs: upgrade --install with version, namespace, values, context", () => {
  const args = buildHelmArgs(baseReq, "kind-test", "/tmp/values.yaml");
  expect(args.upgrade).toEqual([
    "upgrade",
    "--install",
    "my-sentry",
    "sentry/sentry",
    "--version",
    "31.7.1",
    "-n",
    "apps",
    "--create-namespace",
    "-f",
    "/tmp/values.yaml",
    "--kube-context",
    "kind-test",
  ]);
});

test("buildHelmArgs: omits --version when not pinned", () => {
  const args = buildHelmArgs({ ...baseReq, version: null }, null, "/tmp/v.yaml");
  expect(args.upgrade).toEqual([
    "upgrade",
    "--install",
    "my-sentry",
    "sentry/sentry",
    "-n",
    "apps",
    "--create-namespace",
    "-f",
    "/tmp/v.yaml",
  ]);
});

test("buildHelmArgs: omits --kube-context when no context", () => {
  const args = buildHelmArgs(baseReq, null, "/tmp/v.yaml");
  expect(args.upgrade).not.toContain("--kube-context");
});
