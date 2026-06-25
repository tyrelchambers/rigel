import { test, expect, vi } from "vitest";
import { buildDisconnectCommands, disconnectContext, type Run } from "./disconnectContext";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "", code = 1) => ({ code, stdout: "", stderr });

// ---------- buildDisconnectCommands ----------

test("buildDisconnectCommands returns 3 commands when cluster and user are unique to the target", () => {
  const view = {
    contexts: [
      { name: "X", context: { cluster: "C", user: "U" } },
    ],
  };
  expect(buildDisconnectCommands(view, "X")).toEqual([
    ["config", "delete-context", "X"],
    ["config", "delete-cluster", "C"],
    ["config", "delete-user", "U"],
  ]);
});

test("buildDisconnectCommands skips delete-cluster when another context shares the same cluster", () => {
  const view = {
    contexts: [
      { name: "X", context: { cluster: "C", user: "U" } },
      { name: "Y", context: { cluster: "C", user: "V" } },
    ],
  };
  expect(buildDisconnectCommands(view, "X")).toEqual([
    ["config", "delete-context", "X"],
    ["config", "delete-user", "U"],
  ]);
});

test("buildDisconnectCommands keeps a user shared with another context", () => {
  const view = {
    contexts: [
      { name: "do-prod", context: { cluster: "c-prod", user: "shared-user" } },
      { name: "do-stage", context: { cluster: "c-stage", user: "shared-user" } },
    ],
  };
  expect(buildDisconnectCommands(view, "do-prod")).toEqual([
    ["config", "delete-context", "do-prod"],
    ["config", "delete-cluster", "c-prod"],
  ]);
});

test("buildDisconnectCommands returns null when the target context is not present", () => {
  const view = {
    contexts: [
      { name: "other", context: { cluster: "C", user: "U" } },
    ],
  };
  expect(buildDisconnectCommands(view, "missing")).toBeNull();
});

test("buildDisconnectCommands returns null for an empty contexts list", () => {
  expect(buildDisconnectCommands({}, "X")).toBeNull();
});

// ---------- disconnectContext ----------

const kubeconfigPath = "/home/u/.kube/config";
const viewJson = JSON.stringify({
  contexts: [{ name: "X", context: { cluster: "C", user: "U" } }],
});

test("disconnectContext success path: backs up and runs all delete commands", async () => {
  const calls: string[][] = [];
  const run: Run = async (args) => {
    calls.push(args);
    if (args[0] === "config" && args[1] === "view") return ok(viewJson);
    return ok();
  };
  const backup = vi.fn(async () => "/home/u/.kube/config.rigel-backup-x");
  const result = await disconnectContext("X", { kubeconfigPath, run, backup });
  expect(result).toEqual({ ok: true, removed: "X", backupPath: "/home/u/.kube/config.rigel-backup-x" });
  expect(backup).toHaveBeenCalledWith(kubeconfigPath);
  expect(calls).toContainEqual(["config", "delete-context", "X"]);
  expect(calls).toContainEqual(["config", "delete-cluster", "C"]);
  expect(calls).toContainEqual(["config", "delete-user", "U"]);
});

test("disconnectContext returns error when a delete command fails", async () => {
  const run: Run = async (args) => {
    if (args[0] === "config" && args[1] === "view") return ok(viewJson);
    if (args[1] === "delete-context") return fail("error: not found");
    return ok();
  };
  const backup = vi.fn(async () => "/backup");
  const result = await disconnectContext("X", { kubeconfigPath, run, backup });
  expect(result).toEqual({ ok: false, backupPath: "/backup", error: "disconnect failed", stderr: "error: not found" });
});

test("disconnectContext returns error when kubeconfig view fails", async () => {
  const run: Run = async () => fail("permission denied");
  const backup = vi.fn(async () => null);
  const result = await disconnectContext("X", { kubeconfigPath, run, backup });
  expect(result).toEqual({ ok: false, error: "could not read kubeconfig", stderr: "permission denied" });
  expect(backup).not.toHaveBeenCalled();
});

test("disconnectContext returns context-not-found when the target is absent", async () => {
  const run: Run = async (args) => {
    if (args[0] === "config" && args[1] === "view") {
      return ok(JSON.stringify({ contexts: [{ name: "other", context: {} }] }));
    }
    return ok();
  };
  const backup = vi.fn(async () => null);
  const result = await disconnectContext("missing", { kubeconfigPath, run, backup });
  expect(result).toEqual({ ok: false, error: "context not found" });
  expect(backup).not.toHaveBeenCalled();
});

test("disconnectContext returns invalid kubeconfig when view stdout is not JSON", async () => {
  const run: Run = async () => ok("not json at all");
  const backup = vi.fn(async () => null);
  const result = await disconnectContext("X", { kubeconfigPath, run, backup });
  expect(result).toEqual({ ok: false, error: "invalid kubeconfig" });
});
