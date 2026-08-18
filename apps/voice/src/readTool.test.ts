import { describe, expect, test, vi } from "vitest";
import { assertRead, buildReadArgv, runRead, type ReadChild, type ReadVerb, type SpawnRead } from "./readTool.js";

/** A stand-in for a kubectl child process: emits the given chunks, then closes. */
function fakeSpawn(opts: { stdout?: string; stderr?: string; code?: number | null; error?: Error }) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnFn: SpawnRead = (command, args) => {
    calls.push({ command, args });
    const handlers = new Map<string, Array<(arg: never) => void>>();
    const register = (event: string, cb: unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(cb as (arg: never) => void);
      handlers.set(event, list);
    };
    const emit = <T>(event: string, arg: T) => {
      for (const cb of handlers.get(event) ?? []) (cb as unknown as (a: T) => void)(arg);
    };
    queueMicrotask(() => {
      if (opts.error) {
        emit("error", opts.error);
        return;
      }
      if (opts.stdout) emit("stdout", Buffer.from(opts.stdout));
      if (opts.stderr) emit("stderr", Buffer.from(opts.stderr));
      emit("close", opts.code ?? 0);
    });
    return {
      stdout: { on: (_event: string, cb: unknown) => register("stdout", cb) },
      stderr: { on: (_event: string, cb: unknown) => register("stderr", cb) },
      on: (event: string, cb: unknown) => register(event, cb),
    } as unknown as ReadChild;
  };
  return { spawnFn, calls };
}

describe("buildReadArgv", () => {
  test("get without namespace goes cluster-wide", () => {
    expect(buildReadArgv({ verb: "get", kind: "pods" })).toEqual(["get", "pods", "-A", "-o", "wide"]);
  });

  test("get a named resource in a namespace", () => {
    expect(buildReadArgv({ verb: "get", kind: "deployment", name: "web", namespace: "prod" })).toEqual([
      "get",
      "deployment",
      "web",
      "-n",
      "prod",
      "-o",
      "wide",
    ]);
  });

  test("describe requires kind and name", () => {
    expect(() => buildReadArgv({ verb: "describe", kind: "pod" })).toThrow(/name/);
    expect(buildReadArgv({ verb: "describe", kind: "pod", name: "web-1", namespace: "prod" })).toEqual([
      "describe",
      "pod",
      "web-1",
      "-n",
      "prod",
    ]);
  });

  test("logs defaults to a 100-line tail and supports a container", () => {
    expect(buildReadArgv({ verb: "logs", name: "deploy/web", namespace: "prod", container: "app" })).toEqual([
      "logs",
      "deploy/web",
      "-c",
      "app",
      "--tail",
      "100",
      "-n",
      "prod",
    ]);
  });

  test("top nodes takes no namespace flags; top pods does", () => {
    expect(buildReadArgv({ verb: "top", kind: "nodes" })).toEqual(["top", "nodes"]);
    expect(buildReadArgv({ verb: "top" })).toEqual(["top", "pods", "-A"]);
  });

  test("events", () => {
    expect(buildReadArgv({ verb: "events", namespace: "prod" })).toEqual(["events", "-n", "prod"]);
    expect(buildReadArgv({ verb: "events" })).toEqual(["events", "-A"]);
  });

  test("a verb outside the read set never becomes argv", () => {
    expect(() => buildReadArgv({ verb: "delete" as ReadVerb, kind: "pod", name: "web-1" })).toThrow(/delete/);
  });
});

describe("assertRead (the commandPolicy invariant)", () => {
  test("every built read passes classifyCommand", () => {
    for (const argv of [
      buildReadArgv({ verb: "get", kind: "pods" }),
      buildReadArgv({ verb: "describe", kind: "pod", name: "x", namespace: "d" }),
      buildReadArgv({ verb: "logs", name: "x", namespace: "d" }),
      buildReadArgv({ verb: "top", kind: "nodes" }),
      buildReadArgv({ verb: "events" }),
    ]) {
      expect(() => assertRead(argv, "prod")).not.toThrow();
    }
  });

  test("a mutation argv is refused even if it were ever built", () => {
    expect(() => assertRead(["delete", "pod", "web-1"], "prod")).toThrow(/refused/i);
  });

  test("every mutating and blocked verb the classifier knows is refused", () => {
    for (const argv of [
      ["apply", "-f", "x.yaml"],
      ["scale", "deploy/web", "--replicas", "0"],
      ["exec", "web-1", "--", "sh"],
      ["drain", "node-1"],
      ["port-forward", "svc/web", "8080:80"],
      ["rollout", "restart", "deploy/web"],
    ]) {
      expect(() => assertRead(argv, "prod")).toThrow(/refused/i);
    }
  });
});

describe("runRead", () => {
  test("spawns kubectl with the active context in front of the built argv", async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: "NAME  READY\n" });
    const out = await runRead({ verb: "get", kind: "pods", namespace: "prod" }, "kind-rigel", spawnFn);
    expect(calls).toEqual([
      { command: "kubectl", args: ["--context", "kind-rigel", "get", "pods", "-n", "prod", "-o", "wide"] },
    ]);
    expect(out).toBe("NAME  READY\n");
  });

  test("omits --context when no context is active", async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: "ok" });
    await runRead({ verb: "events" }, null, spawnFn);
    expect(calls[0]?.args).toEqual(["events", "-A"]);
  });

  test("caps oversized output and marks it truncated", async () => {
    const { spawnFn } = fakeSpawn({ stdout: "x".repeat(20000) });
    const out = await runRead({ verb: "get", kind: "pods" }, null, spawnFn);
    expect(out).toBe("x".repeat(8192) + "\n[truncated]");
  });

  test("a non-zero exit surfaces the code and the (capped) output", async () => {
    const { spawnFn } = fakeSpawn({ stderr: "Error from server (NotFound)", code: 1 });
    const out = await runRead({ verb: "get", kind: "pod", name: "nope" }, null, spawnFn);
    expect(out).toMatch(/^kubectl exited 1:\nError from server \(NotFound\)$/);
  });

  test("empty successful output still says something the model can speak", async () => {
    const { spawnFn } = fakeSpawn({});
    expect(await runRead({ verb: "get", kind: "pods" }, null, spawnFn)).toBe("(no output)");
  });

  test("a missing kubectl resolves to a message instead of rejecting", async () => {
    const { spawnFn } = fakeSpawn({ error: new Error("spawn kubectl ENOENT") });
    expect(await runRead({ verb: "get", kind: "pods" }, null, spawnFn)).toMatch(/ENOENT/);
  });

  test("nothing is spawned when the argv cannot be built", async () => {
    const spawnFn = vi.fn<SpawnRead>();
    await expect(runRead({ verb: "describe", kind: "pod" }, null, spawnFn)).rejects.toThrow(/name/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
