import { test, expect, vi } from "vitest";
import {
  cloudCheck, cloudListClusters, cloudConnect, cloudHealth, importKubeconfig, cloudParamOptions,
  type Run,
} from "./cloudConnect";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "", code = 1) => ({ code, stdout: "", stderr });

test("cloudCheck reports not-authenticated when the auth probe fails", async () => {
  const run: Run = async (_bin, args) => (args[0] === "account" ? fail("not logged in") : ok());
  expect(await cloudCheck("digitalocean", run)).toEqual({
    cliInstalled: true, extraBinariesInstalled: true, authenticated: false,
  });
});

test("cloudCheck resolves with account email when auth-check returns JSON with email", async () => {
  const run: Run = async (_bin, args) =>
    args[0] === "account" ? ok(JSON.stringify({ email: "me@example.com" })) : ok();
  const result = await cloudCheck("digitalocean", run);
  expect(result.authenticated).toBe(true);
  expect(result.account).toBe("me@example.com");
});

test("cloudCheck reports not-authenticated when the auth-check has no resolvable account", async () => {
  const run: Run = async (_bin, args) => (args[0] === "account" ? ok("") : ok());
  const result = await cloudCheck("digitalocean", run);
  expect(result.authenticated).toBe(false);
  expect("account" in result).toBe(false);
});

test("cloudCheck reports CLI missing when the version probe fails", async () => {
  const run: Run = async () => fail("command not found", -1);
  expect(await cloudCheck("digitalocean", run)).toEqual({
    cliInstalled: false, extraBinariesInstalled: true, authenticated: false,
  });
});

test("cloudCheck returns all-false for an unknown provider", async () => {
  const run: Run = async () => ok();
  expect(await cloudCheck("nope", run)).toEqual({
    cliInstalled: false, extraBinariesInstalled: false, authenticated: false,
  });
});

test("cloudListClusters parses the CLI JSON into clusters", async () => {
  const run: Run = async () => ok(JSON.stringify([{ id: "a", name: "prod", region: "nyc1" }]));
  expect(await cloudListClusters("digitalocean", {}, run)).toEqual({
    clusters: [{ id: "a", name: "prod", region: "nyc1" }],
  });
});

test("cloudListClusters returns stderr on a failed list", async () => {
  const run: Run = async () => fail("boom");
  expect(await cloudListClusters("digitalocean", {}, run)).toEqual({
    error: "failed to list clusters", stderr: "boom",
  });
});

test("cloudListClusters returns a parse error when stdout is not valid JSON", async () => {
  const run: Run = async () => ok("not-json");
  const res = await cloudListClusters("digitalocean", {}, run);
  expect(res.error).toBe("could not parse cluster list");
});

test("cloudConnect runs connect then returns the new current-context + backup", async () => {
  const calls: string[][] = [];
  const run: Run = async (bin, args, opts) => {
    calls.push([bin, ...args]);
    if (args[0] === "config" && args[1] === "current-context") return ok("do-nyc1-prod\n");
    expect(opts?.env?.KUBECONFIG).toBe("/home/u/.kube/config");
    return ok();
  };
  const backup = vi.fn(async () => "/home/u/.kube/config.rigel-backup-x");
  const res = await cloudConnect(
    "digitalocean",
    { id: "abc", name: "prod", region: "nyc1" },
    {},
    { kubeconfigPath: "/home/u/.kube/config", run, backup },
  );
  expect(res).toEqual({ context: "do-nyc1-prod", backupPath: "/home/u/.kube/config.rigel-backup-x" });
  expect(backup).toHaveBeenCalledWith("/home/u/.kube/config");
  expect(calls[0]).toEqual(["doctl", "kubernetes", "cluster", "kubeconfig", "save", "abc"]);
});

test("cloudConnect runs the AKS kubelogin convert step after get-credentials", async () => {
  const calls: string[][] = [];
  const run: Run = async (bin, args, opts) => {
    calls.push([bin, ...args]);
    if (args[0] === "config" && args[1] === "current-context") return ok("prod\n");
    expect(opts?.env?.KUBECONFIG).toBe("/k");
    return ok();
  };
  const res = await cloudConnect(
    "azure",
    { id: "prod", name: "prod", region: "eastus", resourceGroup: "rg1" },
    {},
    { kubeconfigPath: "/k", run, backup: async () => null },
  );
  expect(res.context).toBe("prod");
  expect(calls[0]).toEqual(["az", "aks", "get-credentials", "--resource-group", "rg1", "--name", "prod"]);
  expect(calls[1]).toEqual(["kubelogin", "convert-kubeconfig", "-l", "azurecli"]);
});

test("cloudConnect surfaces a failure in the AKS post-connect step", async () => {
  const run: Run = async (bin) => (bin === "kubelogin" ? fail("kubelogin: command not found", -1) : ok());
  const res = await cloudConnect(
    "azure",
    { id: "prod", name: "prod", region: "eastus", resourceGroup: "rg1" },
    {},
    { kubeconfigPath: "/k", run, backup: async () => null },
  );
  expect(res.error).toBe("post-connect failed");
  expect(res.stderr).toBe("kubelogin: command not found");
});

test("cloudConnect surfaces stderr when the connect command fails", async () => {
  const run: Run = async (_bin, args) =>
    args[0] === "kubernetes" ? fail("403 forbidden") : ok();
  const res = await cloudConnect(
    "digitalocean", { id: "abc", name: "p", region: "r" }, {},
    { kubeconfigPath: "/k", run, backup: async () => null },
  );
  expect(res.error).toBe("connect failed");
  expect(res.stderr).toBe("403 forbidden");
});

test("cloudHealth flags authExpired on a matching stderr", async () => {
  const run: Run = async () => fail("Unable to authenticate you");
  expect(await cloudHealth("digitalocean", "do-nyc1-prod", run)).toEqual({
    ok: false, authExpired: true, stderr: "Unable to authenticate you",
  });
});

test("cloudHealth reports ok when the probe exits 0", async () => {
  const run: Run = async () => ok("{}");
  expect(await cloudHealth("digitalocean", "do-nyc1-prod", run)).toEqual({ ok: true, authExpired: false });
});

test("importKubeconfig merges and returns the incoming context names", async () => {
  const writes: Record<string, string> = {};
  const run: Run = async (_bin, args, opts) => {
    if (args.includes("--flatten")) return ok("merged-yaml");
    // listing the incoming file's contexts
    if ((opts?.env?.KUBECONFIG ?? "").includes("rigel-import")) {
      return ok(JSON.stringify({ contexts: [{ name: "do-nyc1-new" }] }));
    }
    return ok();
  };
  const rm = vi.fn(async () => {});
  const res = await importKubeconfig("apiVersion: v1\nkind: Config", {
    kubeconfigPath: "/home/u/.kube/config",
    run,
    write: async (p, data) => { writes[p] = data; },
    rm,
    backup: async () => "/home/u/.kube/config.rigel-backup-x",
    tmpPath: "/tmp/rigel-import-1.yaml",
  });
  expect(res).toEqual({ ok: true, backupPath: "/home/u/.kube/config.rigel-backup-x", added: ["do-nyc1-new"] });
  expect(writes["/home/u/.kube/config"]).toBe("merged-yaml");
  expect(rm).toHaveBeenCalledWith("/tmp/rigel-import-1.yaml");
});

test("importKubeconfig rejects an invalid kubeconfig", async () => {
  const run: Run = async () => fail("error loading config");
  const res = await importKubeconfig("garbage", {
    kubeconfigPath: "/k", run, write: async () => {}, rm: async () => {}, backup: async () => null,
    tmpPath: "/tmp/rigel-import-2.yaml",
  });
  expect(res.ok).toBe(false);
  expect(res.error).toBe("error loading config");
});

test("importKubeconfig rejects when the incoming kubeconfig view is not valid JSON", async () => {
  const run: Run = async (_bin, args) =>
    args.includes("--flatten") ? ok("merged") : ok("not json at all");
  const res = await importKubeconfig("apiVersion: v1", {
    kubeconfigPath: "/k", run, write: async () => {}, rm: async () => {}, backup: async () => null,
    tmpPath: "/tmp/rigel-import-3.yaml",
  });
  expect(res).toEqual({ ok: false, error: "invalid kubeconfig" });
});

test("cloudListClusters stamps the region from params when the list payload omits it", async () => {
  const run: Run = async () => ok(JSON.stringify({ clusters: ["prod"] }));
  expect(await cloudListClusters("aws", { region: "us-east-1" }, run)).toEqual({
    clusters: [{ id: "prod", name: "prod", region: "us-east-1" }],
  });
});

test("cloudListClusters leaves an existing region untouched", async () => {
  const run: Run = async () => ok(JSON.stringify([{ id: "a", name: "prod", region: "nyc1" }]));
  expect(await cloudListClusters("digitalocean", { region: "us-east-1" }, run)).toEqual({
    clusters: [{ id: "a", name: "prod", region: "nyc1" }],
  });
});

test("cloudParamOptions returns AWS static regions + the configured default", async () => {
  const run: Run = async (_bin, args) =>
    args.join(" ") === "configure get region" ? ok("eu-west-1\n") : fail("unexpected");
  const r = await cloudParamOptions("aws", "region", run);
  expect(r.options).toContain("us-east-1");
  expect(r.default).toBe("eu-west-1");
});

test("cloudParamOptions fetches GCP projects + default, ignoring (unset)", async () => {
  const run: Run = async (_bin, args) =>
    args[0] === "projects" ? ok("proj-a\nproj-b\n") : ok("(unset)\n");
  const r = await cloudParamOptions("gcp", "project", run);
  expect(r.options).toEqual(["proj-a", "proj-b"]);
  expect(r.default).toBeUndefined();
});

test("cloudParamOptions returns empty options for an unknown provider/param", async () => {
  const run: Run = async () => ok();
  expect(await cloudParamOptions("azure", "region", run)).toEqual({ options: [] });
});
