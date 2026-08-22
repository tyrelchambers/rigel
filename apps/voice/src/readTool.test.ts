import { describe, expect, test, vi } from "vitest";
import { assertRead, namedGet, runRead, splitJoinedArgs, type ReadChild, type SpawnRead } from "./readTool.js";

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

describe("splitJoinedArgs", () => {
  // The exact failure: four calls in a row, each dropping a resource type
  // instead of seeing the space, because kubectl's error names the mangled type.
  test("splits a flag that was jammed into the resource-type argument", () => {
    expect(splitJoinedArgs(["get", "deployment,svc,hpa -o", "yaml"])).toEqual([
      "get",
      "deployment,svc,hpa",
      "-o",
      "yaml",
    ]);
    expect(splitJoinedArgs(["get", "deployment,svc -l", "app=web", "-o", "yaml"])).toEqual([
      "get",
      "deployment,svc",
      "-l",
      "app=web",
      "-o",
      "yaml",
    ]);
  });

  test("leaves an argument that merely contains a space alone", () => {
    for (const args of [
      ["get", "pods", "-o", "custom-columns=NAME:.metadata.name,AGE:.metadata.creationTimestamp"],
      ["get", "pods", "-o", "jsonpath={range .items[*]}{.metadata.name}{end}"],
      ["get", "pods", "--field-selector", "status.phase=Running"],
      ["describe", "pod", "web-1"],
    ]) {
      expect(splitJoinedArgs(args), args.join(" ")).toEqual(args);
    }
  });
});

describe("namedGet", () => {
  test("recognises the shapes the NotFound recovery can help with", () => {
    expect(namedGet(["get", "deployment", "web", "-n", "prod"])).toEqual({
      kind: "deployment",
      name: "web",
      namespace: "prod",
    });
    expect(namedGet(["describe", "pod", "web-1"])).toEqual({ kind: "pod", name: "web-1", namespace: undefined });
  });

  test("a listing, a slash form, or anything else has no name to have misheard", () => {
    expect(namedGet(["get", "pods", "-A"])).toBeNull();
    expect(namedGet(["get", "deployment/web", "-n", "prod"])).toBeNull();
    expect(namedGet(["top", "nodes"])).toBeNull();
    expect(namedGet(["api-resources"])).toBeNull();
  });
});

describe("assertRead (the commandPolicy invariant)", () => {
  // The breadth the closed verb set used to forbid. Every one of these is what
  // a human at a read-only terminal would type, and the classifier is what says
  // yes: the shape of the request is not the guard.
  test("arbitrary reads are allowed, including the YAML the agent could never see", () => {
    for (const argv of [
      ["get", "deployment", "web", "-n", "prod", "-o", "yaml"],
      ["get", "svc,ingress,configmap", "-n", "prod", "-o", "json"],
      ["get", "pods", "--selector", "app=web", "-A"],
      ["get", "deployment", "-o", "jsonpath={.items[*].metadata.name}"],
      ["api-resources"],
      ["explain", "deployment.spec"],
      ["rollout", "status", "deployment/web"],
      ["auth", "can-i", "create", "pods"],
      ["logs", "web-1", "--tail", "100"],
      ["top", "nodes"],
      ["events", "-A"],
    ]) {
      expect(() => assertRead(argv, "prod"), argv.join(" ")).not.toThrow();
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

/** Scripted stand-ins for a sequence of kubectl child processes, one per spawn. */
function fakeSpawnSeq(steps: Array<{ stdout?: string; stderr?: string; code?: number | null; error?: Error }>) {
  const calls: Array<{ command: string; args: string[] }> = [];
  let step = 0;
  const spawnFn: SpawnRead = (command, args) => {
    calls.push({ command, args });
    const opts = steps[step++] ?? { stdout: "" };
    const one = fakeSpawn(opts);
    return one.spawnFn(command, args);
  };
  return { spawnFn, calls };
}

describe("runRead", () => {
  test("a joined argument is repaired before it is ever spawned", async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: "ok" });
    await runRead(["get", "deployment,svc -o", "yaml"], null, spawnFn);
    expect(calls[0]?.args).toEqual(["get", "deployment,svc", "-o", "yaml"]);
  });

  test("spawns kubectl with the active context in front of the built argv", async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: "NAME  READY\n" });
    const out = await runRead(["get", "pods", "-n", "prod", "-o", "wide"], "kind-rigel", spawnFn);
    expect(calls).toEqual([
      { command: "kubectl", args: ["--context", "kind-rigel", "get", "pods", "-n", "prod", "-o", "wide"] },
    ]);
    expect(out).toBe("NAME  READY\n");
  });

  test("omits --context when no context is active", async () => {
    const { spawnFn, calls } = fakeSpawn({ stdout: "ok" });
    await runRead(["events", "-A"], null, spawnFn);
    expect(calls[0]?.args).toEqual(["events", "-A"]);
  });

  test("a cut-off read says how much is missing and how to narrow it", async () => {
    const { spawnFn } = fakeSpawn({ stdout: "x".repeat(20000) });
    const out = await runRead(["get", "pods", "-A"], null, spawnFn);
    expect(out.startsWith("x".repeat(8192))).toBe(true);
    expect(out).toContain("20000 characters");
    expect(out).toContain("may end mid-object");
    expect(out).toContain("custom-columns");
  });

  test("a non-zero exit surfaces the code and the (capped) output", async () => {
    const { spawnFn } = fakeSpawn({ stderr: "Error from server (Forbidden)", code: 1 });
    const out = await runRead(["get", "pod", "nope"], null, spawnFn);
    expect(out).toMatch(/^kubectl exited 1:\nError from server \(Forbidden\)$/);
  });

  test("empty successful output still says something the model can speak", async () => {
    const { spawnFn } = fakeSpawn({});
    expect(await runRead(["get", "pods", "-A"], null, spawnFn)).toBe("(no output)");
  });

  test("a missing kubectl resolves to a message instead of rejecting", async () => {
    const { spawnFn } = fakeSpawn({ error: new Error("spawn kubectl ENOENT") });
    expect(await runRead(["get", "pods", "-A"], null, spawnFn)).toMatch(/ENOENT/);
  });

  test("nothing is spawned for an empty read or a mutation", async () => {
    const spawnFn = vi.fn<SpawnRead>();
    await expect(runRead([], null, spawnFn)).rejects.toThrow(/arguments/);
    await expect(runRead(["delete", "pod", "web-1"], null, spawnFn)).rejects.toThrow(/refused/i);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

const NOT_FOUND = 'Error from server (NotFound): deployments.apps "reddex" not found';
const DEPLOY_LIST = [
  "NAME                          READY   UP-TO-DATE   AVAILABLE",
  "reddex-deploy                 3/3     3            3",
  "reddex-custom-website-deploy  1/1     1            1",
  "grafana                       1/1     1            1",
].join("\n");

describe("runRead NotFound recovery", () => {
  test("a named get that misses lists the kind and reports the near matches", async () => {
    const { spawnFn, calls } = fakeSpawnSeq([
      { stderr: NOT_FOUND, code: 1 },
      { stdout: DEPLOY_LIST },
    ]);
    const out = await runRead(["get", "deployment", "reddex", "-n", "default"], null, spawnFn);
    expect(calls.map((c) => c.args)).toEqual([
      // Passed through exactly as the model wrote it; the recovery listing is
      // ours, so it still picks its own -o wide.
      ["get", "deployment", "reddex", "-n", "default"],
      ["get", "deployment", "-n", "default", "-o", "wide"],
    ]);
    expect(out).toContain("No deployment named \"reddex\"");
    expect(out).toContain("3 deployment");
    expect(out).toContain("reddex-deploy");
    expect(out).toContain("reddex-custom-website-deploy");
    expect(out).not.toContain("grafana");
  });

  test("the fallback argv is built and policy-checked exactly like the primary", async () => {
    const { spawnFn, calls } = fakeSpawnSeq([{ stderr: NOT_FOUND, code: 1 }, { stdout: DEPLOY_LIST }]);
    await runRead(["get", "deployment", "reddex", "-n", "default"], "prod", spawnFn);
    for (const call of calls) {
      const argv = call.args.slice(2);
      expect(call.args.slice(0, 2)).toEqual(["--context", "prod"]);
      expect(() => assertRead(argv, "prod")).not.toThrow();
    }
  });

  test("with nothing close by name, the full listing and the count ride along", async () => {
    const { spawnFn } = fakeSpawnSeq([
      { stderr: 'Error from server (NotFound): deployments.apps "nginx" not found', code: 1 },
      { stdout: DEPLOY_LIST },
    ]);
    const out = await runRead(["get", "deployment", "nginx", "-n", "default"], null, spawnFn);
    expect(out).toContain("3 deployment");
    expect(out).toContain("Nothing is close by name");
    expect(out).toContain("reddex-custom-website-deploy");
  });

  test("a describe that misses recovers the same way", async () => {
    const { spawnFn, calls } = fakeSpawnSeq([{ stderr: NOT_FOUND, code: 1 }, { stdout: DEPLOY_LIST }]);
    await runRead(["describe", "deployment", "reddex", "-n", "default"], null, spawnFn);
    expect(calls[1]?.args).toEqual(["get", "deployment", "-n", "default", "-o", "wide"]);
  });

  test("a squashed spoken name still finds its hyphenated resource", async () => {
    const { spawnFn } = fakeSpawnSeq([
      { stderr: 'Error from server (NotFound): deployments.apps "reddexdeploy" not found', code: 1 },
      { stdout: DEPLOY_LIST },
    ]);
    const out = await runRead(["get", "deployment", "reddexdeploy"], null, spawnFn);
    expect(out).toContain("reddex-deploy");
  });

  test("the fallback never fires a third command, even when it fails itself", async () => {
    const { spawnFn, calls } = fakeSpawnSeq([
      { stderr: NOT_FOUND, code: 1 },
      { stderr: "Error from server (Forbidden)", code: 1 },
    ]);
    const out = await runRead(["get", "deployment", "reddex", "-n", "default"], null, spawnFn);
    expect(calls).toHaveLength(2);
    expect(out).toContain("No deployment named \"reddex\"");
    expect(out).toContain("Forbidden");
  });

  test("the fallback output is capped like the primary", async () => {
    const { spawnFn } = fakeSpawnSeq([
      { stderr: 'Error from server (NotFound): deployments.apps "zzz" not found', code: 1 },
      { stdout: "NAME\n" + "x".repeat(20000) },
    ]);
    const out = await runRead(["get", "deployment", "zzz", "-n", "default"], null, spawnFn);
    expect(out).toContain("[truncated:");
    expect(out.length).toBeLessThan(8192 + 512);
  });

  test("a failure that is not a miss, and a listing get, never fall back", async () => {
    const denied = fakeSpawnSeq([{ stderr: "Error from server (Forbidden): deployments.apps is forbidden", code: 1 }]);
    await runRead(["get", "deployment", "reddex", "-n", "default"], null, denied.spawnFn);
    expect(denied.calls).toHaveLength(1);

    const listing = fakeSpawnSeq([{ stdout: "No resources found in default namespace.", code: 0 }]);
    await runRead(["get", "deployment", "-n", "default"], null, listing.spawnFn);
    expect(listing.calls).toHaveLength(1);
  });
});

const PLAINTEXT = "hunter2-super-secret";
const ENCODED = Buffer.from(PLAINTEXT).toString("base64");

describe("runRead never hands a Secret's value to the model", () => {
  const secretYaml = `apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: default
type: Opaque
data:
  password: ${ENCODED}
`;

  test("a yaml read comes back with the shape and without the value", async () => {
    const { spawnFn } = fakeSpawn({ stdout: secretYaml });
    const out = await runRead(["get", "secret", "db-credentials", "-n", "default", "-o", "yaml"], null, spawnFn);
    expect(out).not.toContain(ENCODED);
    expect(out).not.toContain(PLAINTEXT);
    expect(out).toContain("db-credentials");
    expect(out).toContain("password");
  });

  test("a json read is filtered too", async () => {
    const json = JSON.stringify({ kind: "Secret", metadata: { name: "s" }, data: { password: ENCODED } });
    const { spawnFn } = fakeSpawn({ stdout: json });
    const out = await runRead(["get", "secret", "s", "-o", "json"], null, spawnFn);
    expect(out).not.toContain(ENCODED);
  });

  test("a Secret swept up by a multi-kind read is filtered as well", async () => {
    const { spawnFn } = fakeSpawn({ stdout: `${secretYaml}---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  keep: visible\n` });
    const out = await runRead(["get", "secret,configmap", "-n", "default", "-o", "yaml"], null, spawnFn);
    expect(out).not.toContain(ENCODED);
    expect(out).toContain("visible");
  });

  test("value extraction on a secret is refused before it runs, and names the way to read it", async () => {
    const spawnFn = vi.fn<SpawnRead>();
    await expect(
      runRead(["get", "secret", "db", "-o", "jsonpath={.data.password}"], null, spawnFn),
    ).rejects.toThrow(/-o yaml/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
