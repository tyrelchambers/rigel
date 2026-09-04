import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyDataPlans, rewriteCnpgClusterForDump, type KubectlFn } from "./dumpRestore";
import type { DataPlan } from "./types";

const pgPlan: DataPlan = { subject: { kind: "Cluster", namespace: "default", name: "postgres" }, kind: "pgDump" };
const pvcPlan: DataPlan = { subject: { kind: "PersistentVolumeClaim", namespace: "default", name: "uploads" }, kind: "pvcTar" };
const redisPlan: DataPlan = { subject: { kind: "PersistentVolumeClaim", namespace: "default", name: "redis-data" }, kind: "startEmpty" };
const barmanPlan: DataPlan = { subject: { kind: "Cluster", namespace: "default", name: "postgres" }, kind: "cnpgBarman" };

const uploadsPod = {
  metadata: { name: "wildbarrens-server-0", namespace: "default" },
  status: { phase: "Running" },
  spec: {
    volumes: [{ name: "uploads", persistentVolumeClaim: { claimName: "uploads" } }],
    containers: [{ name: "server", volumeMounts: [{ name: "uploads", mountPath: "/app/uploads" }] }],
  },
};

function afterDashDash(args: string[]): string[] {
  const i = args.indexOf("--");
  return i === -1 ? [] : args.slice(i + 1);
}

describe("rewriteCnpgClusterForDump", () => {
  it("drops barman, snapshots, and extra instances", () => {
    const out = rewriteCnpgClusterForDump(
      [
        "apiVersion: postgresql.cnpg.io/v1",
        "kind: Cluster",
        "metadata: { name: postgres, namespace: default }",
        "spec:",
        "  instances: 3",
        "  plugins: [{ name: barman-cloud.cloudnative-pg.io }]",
        "  backup: { volumeSnapshot: { className: longhorn-snapshot } }",
        "  volumeSnapshot: { className: longhorn-snapshot }",
        "  storage: { size: 20Gi, storageClass: local-path }",
        "  bootstrap:",
        "    initdb: { database: app, owner: app }",
        "    recovery: { source: postgres-garage }",
        "",
      ].join("\n"),
      "do-block-storage",
    );
    expect(out).toContain("instances: 1");
    expect(out).not.toContain("barman-cloud");
    expect(out).not.toContain("longhorn-snapshot");
    expect(out).not.toContain("recovery:");
    expect(out).toContain("do-block-storage");
    expect(out).toContain("database: app");
  });
});

describe("copyDataPlans", () => {
  it("dumps discovered databases and restores them without putting dump bytes in the report", async () => {
    const calls: Array<{ ctx: string | null; args: string[]; stdoutFile?: string; stdinFile?: string }> = [];
    const kubectl: KubectlFn = async (ctx, args, opts) => {
      calls.push({ ctx, args, stdoutFile: opts?.stdoutFile, stdinFile: opts?.stdinFile });
      const cmd = afterDashDash(args);
      if (args[0] === "get" && args[1] === "clusters.postgresql.cnpg.io") {
        return { code: 0, stdout: JSON.stringify({ status: { currentPrimary: "postgres-1" } }), stderr: "" };
      }
      if (args[0] === "wait") return { code: 0, stdout: "", stderr: "" };
      if (cmd[0] === "psql" && cmd.includes("-tAc")) {
        return { code: 0, stdout: "reddex\nwildbarrens\n", stderr: "" };
      }
      if (cmd[0] === "pg_dumpall" && opts?.stdoutFile) {
        await writeFile(opts.stdoutFile, "CREATE ROLE app;\n");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd[0] === "pg_dump" && opts?.stdoutFile) {
        await writeFile(opts.stdoutFile, "PGDUMP-BINARY");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd[0] === "createdb") return { code: 0, stdout: "", stderr: "" };
      if (cmd[0] === "psql" && opts?.stdinFile) {
        expect(await readFile(opts.stdinFile, "utf8")).toContain("CREATE ROLE");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd[0] === "pg_restore" && opts?.stdinFile) {
        expect(await readFile(opts.stdinFile, "utf8")).toBe("PGDUMP-BINARY");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const out = await copyDataPlans({
      fromContext: "home",
      toContext: "do-tor1-x",
      plans: [pgPlan],
      kubectl,
      waitTimeout: "1s",
    });

    expect(out.steps).toEqual([
      {
        kind: "pgDump",
        subject: pgPlan.subject,
        action: "copied",
        artifacts: ["globals.sql", "reddex.dump", "wildbarrens.dump"],
      },
    ]);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("CREATE ROLE");
    expect(serialized).not.toContain("PGDUMP-BINARY");

    const dumpCalls = calls.filter((c) => afterDashDash(c.args)[0] === "pg_dump");
    expect(dumpCalls.every((c) => c.ctx === "home")).toBe(true);
    expect(dumpCalls.map((c) => afterDashDash(c.args).at(-1)).sort()).toEqual(["reddex", "wildbarrens"]);
    expect(dumpCalls.some((c) => afterDashDash(c.args).includes("jobwatchcanada"))).toBe(false);

    const restoreCalls = calls.filter((c) => afterDashDash(c.args)[0] === "pg_restore");
    expect(restoreCalls.every((c) => c.ctx === "do-tor1-x")).toBe(true);
    expect(restoreCalls).toHaveLength(2);
  });

  it("does not dump when the plan is off-site barman", async () => {
    const calls: string[][] = [];
    const out = await copyDataPlans({
      fromContext: "home",
      toContext: "do-tor1-x",
      plans: [barmanPlan],
      kubectl: async (_ctx, args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect(out.steps[0]).toMatchObject({ kind: "cnpgBarman", action: "skipped" });
    expect(calls).toEqual([]);
  });

  it("skips redis startEmpty and tars a PVC from the pod that mounts it", async () => {
    const tarCalls: Array<{ ctx: string | null; cmd: string[] }> = [];
    const kubectl: KubectlFn = async (ctx, args, opts) => {
      const cmd = afterDashDash(args);
      if (args[0] === "get" && args[1] === "pods") {
        return { code: 0, stdout: JSON.stringify({ items: [uploadsPod] }), stderr: "" };
      }
      if (cmd[0] === "tar") {
        tarCalls.push({ ctx, cmd });
        if (cmd[1] === "czf" && opts?.stdoutFile) await writeFile(opts.stdoutFile, "TARBYTES");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const out = await copyDataPlans({
      fromContext: "home",
      toContext: "do-tor1-x",
      plans: [redisPlan, pvcPlan],
      kubectl,
    });
    expect(out.steps.find((s) => s.kind === "startEmpty")).toMatchObject({ action: "skipped" });
    expect(out.steps.find((s) => s.kind === "pvcTar")).toMatchObject({
      action: "copied",
      artifacts: ["uploads.tgz"],
    });
    expect(JSON.stringify(out)).not.toContain("TARBYTES");
    expect(tarCalls).toEqual([
      { ctx: "home", cmd: ["tar", "czf", "-", "-C", "/app/uploads", "."] },
      { ctx: "do-tor1-x", cmd: ["tar", "xzf", "-", "-C", "/app/uploads"] },
    ]);
  });

  it("starts a helper pod when nothing running mounts the PVC", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rigel-dump-helper-"));
    let appliedHelper = false;
    const kubectl: KubectlFn = async (_ctx, args, opts) => {
      if (args[0] === "get" && args[1] === "pods") {
        if (!appliedHelper) return { code: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
        return {
          code: 0,
          stdout: JSON.stringify({
            items: [
              {
                metadata: { name: "rigel-copy-uploads", namespace: "default" },
                status: { phase: "Running" },
                spec: {
                  volumes: [{ name: "data", persistentVolumeClaim: { claimName: "uploads" } }],
                  containers: [{ name: "tar", volumeMounts: [{ name: "data", mountPath: "/data" }] }],
                },
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args[0] === "apply") {
        appliedHelper = true;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "wait") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "delete") return { code: 0, stdout: "", stderr: "" };
      const cmd = afterDashDash(args);
      if (cmd[0] === "tar" && cmd[1] === "czf" && opts?.stdoutFile) {
        await writeFile(opts.stdoutFile, "TARBYTES");
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const out = await copyDataPlans({
      fromContext: "home",
      toContext: "do-tor1-x",
      plans: [pvcPlan],
      kubectl,
      tmpDir: dir,
      waitTimeout: "1s",
    });
    expect(appliedHelper).toBe(true);
    expect(out.steps[0]?.action).toBe("copied");
  });
});
