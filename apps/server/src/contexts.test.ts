import { test, expect } from "vitest";
import { parseContexts, listContexts } from "./contexts";

const VIEW = {
  "current-context": "prod-eks",
  contexts: [
    { name: "prod-eks", context: { cluster: "prod-cluster", user: "prod-user" } },
    { name: "home-k3s", context: { cluster: "home-cluster", user: "home-user" } },
  ],
  clusters: [
    { name: "prod-cluster", cluster: { server: "https://prod.example.com" } },
    { name: "home-cluster", cluster: { server: "https://192.168.1.10:6443" } },
  ],
};

test("parseContexts maps each context, resolves its server, and marks the active one", () => {
  const result = parseContexts(VIEW);
  expect(result).toEqual([
    { name: "prod-eks", cluster: "prod-cluster", server: "https://prod.example.com", active: true },
    { name: "home-k3s", cluster: "home-cluster", server: "https://192.168.1.10:6443", active: false },
  ]);
});

test("parseContexts tolerates missing clusters/contexts/server (empty strings, no throw)", () => {
  expect(parseContexts({})).toEqual([]);
  expect(parseContexts({ contexts: [{ name: "bare" }] })).toEqual([
    { name: "bare", cluster: "", server: "", active: false },
  ]);
});

test("listContexts runs `kubectl config view -o json` and parses it", async () => {
  const calls: string[][] = [];
  const fakeRun = async (args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify(VIEW), stderr: "" };
  };
  const result = await listContexts(fakeRun);
  expect(calls[0]).toEqual(["config", "view", "-o", "json"]);
  expect(result.map((c) => c.name)).toEqual(["prod-eks", "home-k3s"]);
  expect(result.find((c) => c.active)?.name).toBe("prod-eks");
});

test("listContexts returns [] when kubectl fails (non-zero exit)", async () => {
  const fakeRun = async () => ({ code: 1, stdout: "", stderr: "no kubeconfig" });
  expect(await listContexts(fakeRun)).toEqual([]);
});
