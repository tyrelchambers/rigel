import { describe, expect, test, vi, afterEach } from "vitest";
import { RequiredTools, isMissingBinaryError } from "./requiredTools";
import type { RunResult } from "@rigel/k8s/src/run";

const ok: RunResult = { code: 0, stdout: "v1.36.3", stderr: "" };
const enoent: RunResult = { code: -1, stdout: "", stderr: "spawn kubectl ENOENT" };
const failed: RunResult = { code: 1, stdout: "", stderr: "connection refused" };

function runner(byBin: Partial<Record<string, RunResult>>) {
  return vi.fn(async (bin: string) => byBin[bin] ?? ok);
}

afterEach(() => vi.useRealTimers());

describe("isMissingBinaryError", () => {
  test("only ENOENT counts as a missing binary", () => {
    expect(isMissingBinaryError(enoent)).toBe(true);
    expect(isMissingBinaryError(failed)).toBe(false);
    expect(isMissingBinaryError(ok)).toBe(false);
  });
});

describe("RequiredTools", () => {
  test("boot probe reports the binaries that are missing, with install URLs", async () => {
    const tools = new RequiredTools(runner({ kubectl: enoent }));
    expect(await tools.probeAll()).toEqual([
      { bin: "kubectl", installUrl: "https://kubernetes.io/docs/tasks/tools/" },
    ]);
    tools.stop();
  });

  test("every required tool carries an install URL", async () => {
    const tools = new RequiredTools(runner({ kubectl: enoent, helm: enoent }));
    const state = await tools.probeAll();
    expect(state.map((t) => t.bin)).toEqual(["kubectl", "helm"]);
    expect(state.every((t) => t.installUrl.startsWith("https://"))).toBe(true);
    tools.stop();
  });

  test("an ENOENT report from a call site flips the tool to missing and emits", () => {
    const tools = new RequiredTools(runner({}));
    const seen: string[][] = [];
    tools.subscribe((state) => seen.push(state.map((t) => t.bin)));

    tools.noteSpawnFailure("kubectl", "spawn kubectl ENOENT");

    expect(seen).toEqual([["kubectl"]]);
    expect(tools.state().map((t) => t.bin)).toEqual(["kubectl"]);
    tools.stop();
  });

  test("a non-ENOENT failure is not a missing binary", () => {
    const tools = new RequiredTools(runner({}));
    const seen: string[][] = [];
    tools.subscribe((state) => seen.push(state.map((t) => t.bin)));

    tools.noteSpawnFailure("kubectl", "connection refused");

    expect(seen).toEqual([]);
    expect(tools.state()).toEqual([]);
    tools.stop();
  });

  test("repeated reports for the same tool emit once", () => {
    const tools = new RequiredTools(runner({}));
    const seen: string[][] = [];
    tools.subscribe((state) => seen.push(state.map((t) => t.bin)));

    tools.noteSpawnFailure("kubectl", "spawn kubectl ENOENT");
    tools.noteSpawnFailure("kubectl", "spawn kubectl ENOENT");

    expect(seen).toHaveLength(1);
    tools.stop();
  });

  test("the recheck timer runs only while something is missing", async () => {
    vi.useFakeTimers();
    const run = runner({ kubectl: enoent });
    const tools = new RequiredTools(run, 10_000);

    await tools.probeAll();
    expect(run).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.mock.calls.length).toBeGreaterThan(2);
    tools.stop();
  });

  test("nothing missing means no timer at all", async () => {
    vi.useFakeTimers();
    const run = runner({});
    const tools = new RequiredTools(run, 10_000);

    await tools.probeAll();
    const afterBoot = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(run.mock.calls.length).toBe(afterBoot);
  });

  test("a probe that answers clears one tool without clearing the other", async () => {
    const results: Record<string, RunResult> = { kubectl: enoent, helm: enoent };
    const tools = new RequiredTools(async (bin: string) => results[bin] ?? ok);
    await tools.probeAll();
    expect(tools.state().map((t) => t.bin)).toEqual(["kubectl", "helm"]);

    results.kubectl = ok;
    await tools.probeAll();

    expect(tools.state().map((t) => t.bin)).toEqual(["helm"]);
    tools.stop();
  });

  test("the timer stops once the last tool comes back", async () => {
    vi.useFakeTimers();
    const results: Record<string, RunResult> = { kubectl: enoent };
    const run = vi.fn(async (bin: string) => results[bin] ?? ok);
    const tools = new RequiredTools(run, 10_000);
    await tools.probeAll();

    results.kubectl = ok;
    await tools.probeAll();
    expect(tools.state()).toEqual([]);

    const settled = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.mock.calls.length).toBe(settled);
  });

  test("clearing the last tool emits the empty state so the UI can hide", async () => {
    const results: Record<string, RunResult> = { kubectl: enoent };
    const tools = new RequiredTools(async (bin: string) => results[bin] ?? ok);
    await tools.probeAll();

    const seen: string[][] = [];
    tools.subscribe((state) => seen.push(state.map((t) => t.bin)));
    results.kubectl = ok;
    await tools.probeAll();

    expect(seen).toEqual([[]]);
  });
});
