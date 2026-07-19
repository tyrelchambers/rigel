import { test, expect } from "vitest";
import { detectClusterTools } from "./clusterTools";

test("detectClusterTools reports each tool present when its probe exits 0", async () => {
  const run = async (_bin: string) => ({ code: 0, stdout: "", stderr: "" });
  expect(await detectClusterTools(run, "darwin")).toEqual({
    kind: true, k3d: true, dockerRunning: true, os: "mac", installer: { id: "brew", present: true },
  });
});

test("detectClusterTools reports a missing tool / stopped docker on non-zero exit", async () => {
  const run = async (bin: string, _args: string[]) => ({
    code: bin === "kind" ? 0 : bin === "docker" ? 1 : -1,
    stdout: "", stderr: "",
  });
  // winget probes to a non-zero exit here, so it reports the installer absent.
  expect(await detectClusterTools(run, "win32")).toEqual({
    kind: true, k3d: false, dockerRunning: false, os: "windows", installer: { id: "winget", present: false },
  });
});

test("detectClusterTools maps the platform to an install-friendly OS name", async () => {
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
  expect((await detectClusterTools(run, "darwin")).os).toBe("mac");
  expect((await detectClusterTools(run, "win32")).os).toBe("windows");
  expect((await detectClusterTools(run, "linux")).os).toBe("linux");
});

test("detectClusterTools probes the OS package manager (brew/winget), and Linux has none", async () => {
  // brew present on mac
  const brewOk = async (bin: string) => ({ code: bin === "brew" ? 0 : 0, stdout: "", stderr: "" });
  expect((await detectClusterTools(brewOk, "darwin")).installer).toEqual({ id: "brew", present: true });
  // brew missing on mac
  const noBrew = async (bin: string) => ({ code: bin === "brew" ? 1 : 0, stdout: "", stderr: "" });
  expect((await detectClusterTools(noBrew, "darwin")).installer).toEqual({ id: "brew", present: false });
  // linux installs from the binary; no package manager to probe
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
  expect((await detectClusterTools(run, "linux")).installer).toBeNull();
});
