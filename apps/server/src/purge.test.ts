import { test, expect } from "bun:test";
import { discover, execute, type PurgeRunners } from "./purge";
import type { RunResult } from "@helmsman/k8s/src/run";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom", code = 1): RunResult => ({ code, stdout: "", stderr });

/** A runner that records every call and returns scripted results. */
function recorder(
  kubectlResults: RunResult[],
  helmResult: RunResult = ok(),
): { runners: PurgeRunners; kubectlCalls: string[][]; helmCalls: string[][] } {
  const kubectlCalls: string[][] = [];
  const helmCalls: string[][] = [];
  let i = 0;
  return {
    kubectlCalls,
    helmCalls,
    runners: {
      kubectlRun: async (_ctx, args) => {
        kubectlCalls.push(args);
        return kubectlResults[i++] ?? ok();
      },
      helmRun: async (args) => {
        helmCalls.push(args);
        return helmResult;
      },
    },
  };
}

const DISCOVERY_JSON = JSON.stringify({
  items: [
    { kind: "Deployment", metadata: { name: "memos" } },
    { kind: "PersistentVolumeClaim", metadata: { name: "memos-data" } },
    { kind: "Secret", metadata: { name: "sh.helm.release.v1.memos.v1" } },
  ],
});

// ---------------------------------------------------------------------------
// discover (dry-run)
// ---------------------------------------------------------------------------

test("discover: protected namespace returns blockedReason and no query", async () => {
  const r = recorder([]);
  const res = await discover("ctx", "kube-system", "anything", r.runners);
  expect(res.blockedReason).toBe("kube-system is a protected system namespace");
  expect(res.discovered).toEqual([]);
  expect(r.kubectlCalls.length).toBe(0); // never queried
});

test("discover: label query, filtered resources, helm release detected", async () => {
  const r = recorder([ok(DISCOVERY_JSON)]);
  const res = await discover("ctx", "default", "memos", r.runners);
  expect(res.helmRelease).toBe("memos");
  const names = res.discovered.map((d) => `${d.kind}/${d.name}`);
  expect(names).toContain("deployment/memos");
  expect(names).toContain("persistentvolumeclaim/memos-data");
  // helm bookkeeping secret is never an individual delete
  expect(names).not.toContain("secret/sh.helm.release.v1.memos.v1");
  // first call is the label query
  expect(r.kubectlCalls[0]).toContain("app.kubernetes.io/instance=memos");
});

test("discover: empty label match falls back to name-prefix query", async () => {
  const r = recorder([ok(JSON.stringify({ items: [] })), ok(DISCOVERY_JSON)]);
  const res = await discover("ctx", "default", "memos", r.runners);
  expect(r.kubectlCalls.length).toBe(2);
  expect(r.kubectlCalls[1]).not.toContain("-l"); // fallback has no label selector
  expect(res.discovered.some((d) => d.name === "memos")).toBe(true);
});

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

test("execute: helm uninstall runs first, then deletes", async () => {
  const r = recorder([ok(), ok()], ok());
  const res = await execute(
    "ctx",
    {
      namespace: "default",
      instance: "memos",
      helmRelease: "memos",
      resources: [
        { kind: "deployment", name: "memos", namespace: "default" },
        { kind: "persistentvolumeclaim", name: "memos-data", namespace: "default" },
      ],
    },
    r.runners,
  );
  expect(res.ok).toBe(true);
  expect(r.helmCalls[0]).toEqual(["--kube-context", "ctx", "uninstall", "memos", "-n", "default"]);
  expect(res.results[0]).toEqual({ resource: "helm/memos", ok: true, detail: "uninstalled" });
  expect(r.kubectlCalls[0]).toEqual(["delete", "deployment", "memos", "-n", "default"]);
  expect(r.kubectlCalls[1]).toEqual(["delete", "pvc", "memos-data", "-n", "default"]);
});

test("execute: helm uninstall failure STOPS before any kubectl delete", async () => {
  const r = recorder([ok()], fail("release not found"));
  const res = await execute(
    "ctx",
    {
      namespace: "default",
      instance: "memos",
      helmRelease: "memos",
      resources: [{ kind: "deployment", name: "memos", namespace: "default" }],
    },
    r.runners,
  );
  expect(res.ok).toBe(false);
  expect(res.results).toHaveLength(1);
  expect(res.results[0].resource).toBe("helm/memos");
  expect(res.results[0].ok).toBe(false);
  expect(r.kubectlCalls.length).toBe(0); // no deletes attempted
});

test("execute: partial delete failure continues and reports each", async () => {
  const r = recorder([ok(), fail("not found", 1)]);
  const res = await execute(
    "ctx",
    {
      namespace: "default",
      instance: "memos",
      resources: [
        { kind: "deployment", name: "memos", namespace: "default" },
        { kind: "service", name: "memos", namespace: "default" },
      ],
    },
    r.runners,
  );
  expect(res.ok).toBe(false); // one failed
  expect(res.results[0]).toEqual({ resource: "deployment/memos", ok: true, detail: "deleted" });
  expect(res.results[1].ok).toBe(false);
  expect(res.results[1].detail).toBe("not found");
});

test("execute: protected namespace on the request is refused outright", async () => {
  const r = recorder([]);
  const res = await execute(
    "ctx",
    { namespace: "kube-system", instance: "x", resources: [{ kind: "deployment", name: "x", namespace: "kube-system" }] },
    r.runners,
  );
  expect(res.ok).toBe(false);
  expect(res.results[0].detail).toContain("protected");
  expect(r.kubectlCalls.length).toBe(0);
});

test("execute: shared-infra workload is skipped, not deleted", async () => {
  const r = recorder([ok()]);
  const res = await execute(
    "ctx",
    {
      namespace: "default",
      instance: "memos",
      resources: [
        { kind: "deployment", name: "postgres", namespace: "default" },
        { kind: "service", name: "memos", namespace: "default" },
      ],
    },
    r.runners,
  );
  const postgres = res.results.find((x) => x.resource === "deployment/postgres");
  expect(postgres?.ok).toBe(false);
  expect(postgres?.detail).toContain("shared-infra");
  // only the service delete actually ran
  expect(r.kubectlCalls).toEqual([["delete", "service", "memos", "-n", "default"]]);
});

test("execute: dropDatabase yields an informational non-ok result (never executed)", async () => {
  const r = recorder([ok()]);
  const res = await execute(
    "ctx",
    {
      namespace: "default",
      instance: "memos",
      resources: [{ kind: "deployment", name: "memos", namespace: "default" }],
      dropDatabase: true,
      databaseHint: "memos",
    },
    r.runners,
  );
  const db = res.results.find((x) => x.resource === "database/memos");
  expect(db?.ok).toBe(false);
  expect(db?.detail).toContain("run manually");
  // only the deployment delete ran — no DB command
  expect(r.kubectlCalls).toHaveLength(1);
});
