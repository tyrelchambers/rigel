import { test, expect } from "vitest";
import { detectClusterTools } from "./clusterTools";

test("detectClusterTools reports each tool present when its probe exits 0", async () => {
  const run = async (_bin: string) => ({ code: 0, stdout: "", stderr: "" });
  expect(await detectClusterTools(run)).toEqual({ kind: true, k3d: true, dockerRunning: true });
});

test("detectClusterTools reports a missing tool / stopped docker on non-zero exit", async () => {
  const run = async (bin: string, _args: string[]) => ({
    code: bin === "kind" ? 0 : bin === "docker" ? 1 : -1,
    stdout: "", stderr: "",
  });
  expect(await detectClusterTools(run)).toEqual({ kind: true, k3d: false, dockerRunning: false });
});
