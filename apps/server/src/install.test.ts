import { describe, test, expect, vi } from "vitest";
import { buildApplyArgs, applyManifest } from "./install";
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

describe("applyManifest ledger recording", () => {
  const yaml = ["apiVersion: apps/v1", "kind: Deployment", "metadata:", "  name: web", "  namespace: shop"].join("\n");

  test("writes a ledger ConfigMap for created resources when source is given", async () => {
    const applyRun = vi.fn().mockResolvedValue({ code: 0, stdout: "deployment.apps/web created", stderr: "" });
    const ledgerRun = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const res = await applyManifest(null, yaml, false, "compose-migration", {
      applyRun,
      ledgerRun,
      idGen: () => "batch-1",
      clock: () => new Date("2026-07-07T10:00:00.000Z"),
    });

    expect(res.code).toBe(0);
    expect(res.batchId).toBe("batch-1");
    expect(ledgerRun).toHaveBeenCalledTimes(1);
    const [ctx, manifestJson] = ledgerRun.mock.calls[0]!;
    expect(ctx).toBeNull();
    const cm = JSON.parse(manifestJson as string);
    expect(cm.metadata.name).toBe("rigel-apply-batch-1");
    expect(cm.metadata.namespace).toBe("shop");
    expect(cm.metadata.labels).toEqual({ "rigel.dev/ledger": "apply-batch" });
    expect(JSON.parse(cm.data["batch.json"])).toEqual({
      batchId: "batch-1",
      appliedAt: "2026-07-07T10:00:00.000Z",
      source: "compose-migration",
      resources: [{ kind: "Deployment", name: "web", namespace: "shop" }],
    });
  });

  test("does not write a ledger on dryRun / missing source / invalid source / apply failure / nothing created", async () => {
    const ledgerRun = vi.fn();
    const created = { code: 0, stdout: "deployment.apps/web created", stderr: "" };
    const base = { ledgerRun, idGen: () => "b", clock: () => new Date(0) };

    await applyManifest(null, yaml, true, "compose-migration", { applyRun: vi.fn().mockResolvedValue(created), ...base });
    await applyManifest(null, yaml, false, undefined, { applyRun: vi.fn().mockResolvedValue(created), ...base });
    await applyManifest(null, yaml, false, "bogus", { applyRun: vi.fn().mockResolvedValue(created), ...base });
    await applyManifest(null, yaml, false, "compose-migration", { applyRun: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "boom" }), ...base });
    await applyManifest(null, yaml, false, "compose-migration", { applyRun: vi.fn().mockResolvedValue({ code: 0, stdout: "deployment.apps/web configured", stderr: "" }), ...base });

    expect(ledgerRun).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Catalog [Update] on a Helm-managed app — in-place reuse-values upgrade
// ---------------------------------------------------------------------------
import { installHelm } from "./install";

test("installHelm reuse-values upgrade runs repo add → update → upgrade with no values file", async () => {
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = await installHelm(
    "kind-test",
    {
      source: { kind: "repo", repoName: "signoz", repoURL: "https://charts.signoz.io", chart: "signoz", version: "0.147.0" },
      releaseName: "signoz",
      namespace: "signoz",
      reuseValues: true,
    },
    run,
  );
  expect(r.code).toBe(0);
  expect(calls).toEqual([
    ["repo", "add", "--", "signoz", "https://charts.signoz.io"],
    ["repo", "update", "--", "signoz"],
    ["upgrade", "--version", "0.147.0", "--reuse-values", "-n", "signoz", "--kube-context", "kind-test", "--", "signoz", "signoz/signoz"],
  ]);
});

test("installHelm with values still writes a values file and runs upgrade --install", async () => {
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    return { code: 0, stdout: "", stderr: "" };
  };
  await installHelm(
    null,
    { source: { kind: "oci", ref: "oci://r/c", version: "1.0.0" }, releaseName: "web", namespace: "apps", values: "a: 1\n" },
    run,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]!.slice(0, 2)).toEqual(["upgrade", "--install"]);
  expect(calls[0]).toContain("-f");
});
