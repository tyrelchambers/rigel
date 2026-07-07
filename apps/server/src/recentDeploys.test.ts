import { describe, expect, test, vi } from "vitest";
import { discoverRecent, undoBatch } from "./recentDeploys";

describe("discoverRecent", () => {
  test("lists ledger ConfigMaps across namespaces and returns windowed batches", async () => {
    const items = {
      items: [
        { metadata: { namespace: "shop" }, data: { "batch.json": JSON.stringify({ batchId: "b1", appliedAt: "2026-07-07T10:00:00.000Z", source: "compose-migration", resources: [{ kind: "Deployment", name: "web", namespace: "shop" }] }) } },
      ],
    };
    const kubectlRun = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify(items), stderr: "" });
    const res = await discoverRecent(null, Date.parse("2026-07-07T12:00:00.000Z"), { kubectlRun });
    expect(kubectlRun.mock.calls[0]![1]).toEqual(["get", "configmap", "--all-namespaces", "-l", "rigel.dev/ledger=apply-batch", "-o", "json"]);
    expect(res.batches).toHaveLength(1);
    expect(res.batches[0]!.batchId).toBe("b1");
    expect(res.batches[0]!.ledgerNamespace).toBe("shop");
  });

  test("returns empty on query failure", async () => {
    const kubectlRun = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "boom" });
    expect((await discoverRecent(null, Date.now(), { kubectlRun })).batches).toEqual([]);
  });

  test("GCs ledgers older than the 14-day window and omits them from the result", async () => {
    const items = {
      items: [
        { metadata: { name: "rigel-apply-old", namespace: "shop" }, data: { "batch.json": JSON.stringify({ batchId: "old", appliedAt: "2026-06-01T10:00:00.000Z", source: "apply-yaml", resources: [] }) } },
        { metadata: { name: "rigel-apply-new", namespace: "shop" }, data: { "batch.json": JSON.stringify({ batchId: "new", appliedAt: "2026-07-07T10:00:00.000Z", source: "apply-yaml", resources: [] }) } },
      ],
    };
    const kubectlRun = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify(items), stderr: "" });
    const res = await discoverRecent(null, Date.parse("2026-07-07T12:00:00.000Z"), { kubectlRun });

    expect(kubectlRun.mock.calls[1]![1]).toEqual(["delete", "configmap", "rigel-apply-old", "-n", "shop", "--ignore-not-found"]);
    expect(kubectlRun).toHaveBeenCalledTimes(2); // list + one GC delete; the in-window ledger is untouched
    expect(res.batches.map((b) => b.batchId)).toEqual(["new"]);
  });
});

describe("undoBatch", () => {
  const ledger = {
    metadata: { namespace: "shop" },
    data: { "batch.json": JSON.stringify({ batchId: "b1", appliedAt: "2026-07-07T10:00:00.000Z", source: "apply-yaml", resources: [
      { kind: "Deployment", name: "web", namespace: "shop" },
      { kind: "Service", name: "web", namespace: "shop" },
    ] }) },
  };

  test("reads the ledger (in its namespace), deletes each resource by its own kind, then deletes the ledger", async () => {
    const kubectlRun = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(ledger), stderr: "" }) // get ledger
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }) // delete deployment
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }) // delete service
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }); // delete ledger cm

    const res = await undoBatch(null, "b1", "shop", { kubectlRun });

    expect(kubectlRun.mock.calls[0]![1]).toEqual(["get", "configmap", "rigel-apply-b1", "-n", "shop", "-o", "json"]);
    expect(kubectlRun.mock.calls[1]![1]).toEqual(["delete", "Deployment", "web", "-n", "shop", "--ignore-not-found"]);
    expect(kubectlRun.mock.calls[2]![1]).toEqual(["delete", "Service", "web", "-n", "shop", "--ignore-not-found"]);
    expect(kubectlRun.mock.calls[3]![1]).toEqual(["delete", "configmap", "rigel-apply-b1", "-n", "shop", "--ignore-not-found"]);
    expect(res.ok).toBe(true);
    expect(res.results).toEqual([
      { resource: "Deployment/web", ok: true, detail: "deleted" },
      { resource: "Service/web", ok: true, detail: "deleted" },
    ]);
  });

  test("on a partial failure, keeps the ledger (no ledger delete) and reports not-ok", async () => {
    const kubectlRun = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(ledger), stderr: "" }) // get ledger
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" }) // delete deployment ok
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "forbidden" }); // delete service fails

    const res = await undoBatch(null, "b1", "shop", { kubectlRun });

    expect(kubectlRun).toHaveBeenCalledTimes(3); // get + 2 deletes; NO ledger delete
    expect(res.ok).toBe(false);
    expect(res.results).toEqual([
      { resource: "Deployment/web", ok: true, detail: "deleted" },
      { resource: "Service/web", ok: false, detail: "forbidden" },
    ]);
  });

  test("errors when the ledger is missing", async () => {
    const kubectlRun = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "NotFound" });
    const res = await undoBatch(null, "gone", "shop", { kubectlRun });
    expect(res.ok).toBe(false);
    expect(res.results).toEqual([{ resource: "batch/gone", ok: false, detail: "ledger not found" }]);
  });
});
