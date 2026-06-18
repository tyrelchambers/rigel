import { WatchEventParser, type WatchEvent } from "@helmsman/k8s/src/watch";
import { spawn, type ChildProcess } from "node:child_process";

export function applyEvent(cache: Map<string, any>, e: WatchEvent): void {
  const name = e.object?.metadata?.name;
  if (!name) return;
  if (e.type === "DELETED") cache.delete(name);
  else cache.set(name, e.object);
}

type Sub = { kind: string; namespace: string };
const subKey = (s: Sub) => `${s.kind}/${s.namespace}`;

type Watch = {
  proc: ChildProcess;
  cache: Map<string, any>;
  listeners: Set<(e: WatchEvent) => void>;
};

export class WatchManager {
  private context: string | null;
  private watches = new Map<string, Watch>();

  constructor(context: string | null) {
    this.context = context;
  }

  subscribe(
    sub: Sub,
    onSnapshot: (items: any[]) => void,
    onDelta: (e: WatchEvent) => void,
  ): () => void {
    const key = subKey(sub);
    let w = this.watches.get(key);
    if (!w) w = this.start(sub, key);
    w.listeners.add(onDelta);
    onSnapshot([...w.cache.values()]);
    return () => {
      w!.listeners.delete(onDelta);
      if (w!.listeners.size === 0) this.stop(key);
    };
  }

  private start(sub: Sub, key: string): Watch {
    const nsArgs =
      sub.namespace === "*" ? ["--all-namespaces"] : ["-n", sub.namespace];
    const argv = [
      "kubectl",
      ...(this.context ? ["--context", this.context] : []),
      "get",
      sub.kind,
      ...nsArgs,
      "--watch",
      "--output-watch-events",
      "-o",
      "json",
    ];
    const proc = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
    const cache = new Map<string, any>();
    const listeners = new Set<(e: WatchEvent) => void>();
    const parser = new WatchEventParser();
    const w: Watch = { proc, cache, listeners };
    this.watches.set(key, w);
    proc.stdout!.on("data", (buf: Buffer) => {
      parser.push(buf.toString("utf8"), (e) => {
        applyEvent(cache, e);
        for (const l of listeners) l(e);
      });
    });
    return w;
  }

  private stop(key: string): void {
    this.watches.get(key)?.proc.kill();
    this.watches.delete(key);
  }
}
