import { test, expect } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { buildLogsArgs, LogStreamManager, type LogTarget } from "./logStream";

test("buildLogsArgs: deployment label selector matches the Swift tail command", () => {
  const t: LogTarget = { namespace: "default", labelSelector: "app=web,tier=fe" };
  expect(buildLogsArgs(t, 200)).toEqual([
    "logs",
    "-f",
    "--timestamps",
    "--prefix=true",
    "--all-containers=true",
    "-n",
    "default",
    "-l",
    "app=web,tier=fe",
    "--max-log-requests=20",
    "--tail=200",
  ]);
});

test("buildLogsArgs: single pod uses the pod name (no -l)", () => {
  const t: LogTarget = { namespace: "kube-system", pod: "coredns-1" };
  const args = buildLogsArgs(t, 50);
  expect(args).toContain("coredns-1");
  expect(args).not.toContain("-l");
  expect(args).toContain("--tail=50");
});

// Fake node:child_process spawn: records the argv (bin + args, as the original
// Bun-shaped test asserted on a combined array) and exposes a killed flag plus a
// scripted stdout. Returns a ChildProcess-shaped stub: stdout/stderr are Node
// Readables and `on("close", …)` is emitted after stdout drains.
function fakeSpawn(lines: string[]) {
  const spawned: { argv: string[]; killed: boolean }[] = [];
  const fn = ((bin: string, args: string[]) => {
    const rec = { argv: [bin, ...args], killed: false };
    spawned.push(rec);
    const stdout = Readable.from(lines.map((l) => l + "\n"));
    const stderr = Readable.from([]);
    const proc = new EventEmitter() as any;
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.kill = () => {
      rec.killed = true;
    };
    // Emit "close" once stdout finishes so any `once(proc, "close")` resolves.
    stdout.on("end", () => proc.emit("close", 0));
    return proc;
  }) as unknown as typeof spawn;
  return { fn, spawned };
}

test("start spawns one kubectl per target and prepends --context", () => {
  const { fn, spawned } = fakeSpawn([]);
  const sent: any[] = [];
  const mgr = new LogStreamManager({ send: (s: string) => sent.push(JSON.parse(s)) }, "prod", fn);
  mgr.start([{ namespace: "default", labelSelector: "app=web" }]);
  expect(spawned.length).toBe(1);
  expect(spawned[0].argv.slice(0, 4)).toEqual(["kubectl", "--context", "prod", "logs"]);
  expect(mgr.activeCount).toBe(1);
});

test("forwarded lines parse pod/container from the --prefix prefix", async () => {
  const { fn } = fakeSpawn(["[pod/web-abc/app] 2025-06-09T17:15:42.000Z hello"]);
  const sent: any[] = [];
  const mgr = new LogStreamManager({ send: (s: string) => sent.push(JSON.parse(s)) }, null, fn);
  mgr.start([{ namespace: "default", labelSelector: "app=web" }]);
  // Let the stdout pump drain the scripted stream.
  await new Promise((r) => setTimeout(r, 10));
  const logMsg = sent.find((m) => m.type === "logs");
  expect(logMsg).toBeTruthy();
  expect(logMsg.pod).toBe("web-abc");
  expect(logMsg.container).toBe("app");
  expect(logMsg.namespace).toBe("default");
  expect(logMsg.line).toContain("hello");
});

test("stop kills every spawned process and clears the active count", () => {
  const { fn, spawned } = fakeSpawn([]);
  const mgr = new LogStreamManager({ send: () => 0 }, null, fn);
  mgr.start([
    { namespace: "a", labelSelector: "x=1" },
    { namespace: "b", labelSelector: "y=2" },
  ]);
  expect(spawned.length).toBe(2);
  mgr.stop();
  expect(spawned.every((s) => s.killed)).toBe(true);
  expect(mgr.activeCount).toBe(0);
});

test("a fresh start supersedes (kills) the previous selection", () => {
  const { fn, spawned } = fakeSpawn([]);
  const mgr = new LogStreamManager({ send: () => 0 }, null, fn);
  mgr.start([{ namespace: "a", labelSelector: "x=1" }]);
  mgr.start([{ namespace: "b", labelSelector: "y=2" }]);
  expect(spawned[0].killed).toBe(true);
  expect(mgr.activeCount).toBe(1);
});

test("buildLogsArgs: container uses -c and omits --all-containers", () => {
  const t: LogTarget = { namespace: "default", labelSelector: "app=web", container: "app" };
  const args = buildLogsArgs(t, 200);
  expect(args).toContain("-c");
  expect(args[args.indexOf("-c") + 1]).toBe("app");
  expect(args).not.toContain("--all-containers=true");
});

test("buildLogsArgs: previous drops -f and adds --previous", () => {
  const t: LogTarget = { namespace: "default", labelSelector: "app=web", previous: true };
  const args = buildLogsArgs(t, 200);
  expect(args).not.toContain("-f");
  expect(args).toContain("--previous");
});

test("buildLogsArgs: since adds --since=<v>", () => {
  const t: LogTarget = { namespace: "default", pod: "web-0", since: "5m" };
  expect(buildLogsArgs(t, 100)).toContain("--since=5m");
});

test("buildLogsArgs: default (no container/previous/since) is unchanged", () => {
  const t: LogTarget = { namespace: "default", labelSelector: "app=web" };
  expect(buildLogsArgs(t, 200)).toEqual([
    "logs", "-f", "--timestamps", "--prefix=true", "--all-containers=true",
    "-n", "default", "-l", "app=web", "--max-log-requests=20", "--tail=200",
  ]);
});
