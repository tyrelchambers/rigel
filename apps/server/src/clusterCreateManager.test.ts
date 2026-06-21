import { test, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ClusterCreateManager } from "./clusterCreateManager";

function fakeProc() {
  const p = new EventEmitter() as any;
  p.stdout = new PassThrough();
  p.stderr = new PassThrough();
  p.kill = vi.fn();
  return p;
}
function fakeWs() {
  const sent: any[] = [];
  return { sent, send: (raw: string) => sent.push(JSON.parse(raw)) };
}

test("create backs up the kubeconfig, spawns the tool with KUBECONFIG, streams progress, then done", async () => {
  const proc = fakeProc();
  const spawns: any[] = [];
  const spawnFn = (bin: string, args: string[], opts: any) => { spawns.push({ bin, args, opts }); return proc; };
  const ws = fakeWs();
  const backups: string[] = [];
  const mgr = new ClusterCreateManager(ws as any, "/k/config", spawnFn as any, async () => { backups.push("/k/config.bak"); return "/k/config.bak"; });

  await mgr.create({ tool: "kind", name: "dev", version: "default" });

  expect(backups.length).toBe(1);
  expect(spawns[0].bin).toBe("kind");
  expect(spawns[0].args).toEqual(["create", "cluster", "--name", "dev"]);
  expect(spawns[0].opts.env.KUBECONFIG).toBe("/k/config");

  proc.stdout.write("Creating cluster...\n");
  await new Promise((r) => setImmediate(r));
  expect(ws.sent.find((m) => m.type === "cluster.progress" && /Creating/.test(m.line))).toBeTruthy();

  proc.emit("close", 0);
  await new Promise((r) => setImmediate(r));
  const done = ws.sent.find((m) => m.type === "cluster.done");
  expect(done).toMatchObject({ context: "kind-dev", backupPath: "/k/config.bak" });
});

test("a non-zero exit emits cluster.error", async () => {
  const proc = fakeProc();
  const ws = fakeWs();
  const mgr = new ClusterCreateManager(ws as any, "/k/config", (() => proc) as any, async () => null);
  await mgr.create({ tool: "k3d", name: "x", version: "default" });
  proc.stderr.write("boom\n");
  proc.emit("close", 1);
  await new Promise((r) => setImmediate(r));
  expect(ws.sent.find((m) => m.type === "cluster.error")).toBeTruthy();
});

test("an invalid name errors without spawning", async () => {
  const ws = fakeWs();
  const spawnFn = vi.fn();
  const mgr = new ClusterCreateManager(ws as any, "/k/config", spawnFn as any, async () => null);
  await mgr.create({ tool: "kind", name: "BAD NAME", version: "default" });
  expect(spawnFn).not.toHaveBeenCalled();
  expect(ws.sent.find((m) => m.type === "cluster.error")).toBeTruthy();
});
