import { WatchEventParser, type WatchEvent } from "@rigel/k8s/src/watch";
import { spawn, type ChildProcess } from "node:child_process";

export function applyEvent(cache: Map<string, any>, e: WatchEvent): void {
  const name = e.object?.metadata?.name;
  if (!name) return;
  if (e.type === "DELETED") cache.delete(name);
  else cache.set(name, e.object);
}

type Sub = { context?: string | null; kind: string; namespace: string };

// How long a warm watch with zero listeners lives before teardown. Keeps the
// cache hot across tab switches so re-subscribing is an instant warm hit.
export const IDLE_TTL_MS = 5 * 60 * 1000;
// Restart backoff for a watch-stream that died on its own. Grows 1s, 2s, 4s...
// capped at 30s; resets to base after a clean LIST + watch start. There is NO
// hard attempt cap: the backoff cap already prevents a hot loop, and retrying
// forever (at most once per 30s) lets a kind self-heal, e.g. a CRD installed a
// minute later. Truly-unused failing watches are reaped by the idle TTL.
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
// Cap the backoff exponent so the delay math settles at RESTART_MAX_MS and the
// attempt counter can't blow up over a long-lived retry.
const RESTART_MAX_EXP = 6;

export type WatchManagerOptions = {
  idleTtlMs?: number;
  restartBaseMs?: number;
  restartMaxMs?: number;
};

// One client subscription: its snapshot callback (re-fired on every authoritative
// LIST, including restarts/resyncs) and its per-event delta callback.
type Listener = {
  onSnapshot: (items: any[]) => void;
  onDelta: (e: WatchEvent) => void;
};

type Watch = {
  sub: Sub;
  cache: Map<string, any>;
  listeners: Set<Listener>;
  // The one-shot LIST and the long-lived delta stream. Either may be null
  // between phases (e.g. during the LIST, the watch proc isn't spawned yet).
  listProc: ChildProcess | null;
  watchProc: ChildProcess | null;
  ready: boolean; // the cache has been populated by a completed LIST
  pinned: boolean; // prewarmed: never idle-stopped, kept fresh with no listeners
  stopping: boolean; // an intentional stop() is in progress (suppresses restart)
  idleTimer: ReturnType<typeof setTimeout> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  restarts: number; // consecutive restart attempts (reset on a good LIST)
};

export class WatchManager {
  private watches = new Map<string, Watch>();
  private idleTtlMs: number;
  private restartBaseMs: number;
  private restartMaxMs: number;

  constructor(
    private defaultContext: string | null,
    private spawnFn: typeof spawn = spawn,
    opts: WatchManagerOptions = {},
  ) {
    this.idleTtlMs = opts.idleTtlMs ?? IDLE_TTL_MS;
    this.restartBaseMs = opts.restartBaseMs ?? RESTART_BASE_MS;
    this.restartMaxMs = opts.restartMaxMs ?? RESTART_MAX_MS;
  }

  // The watch key identifies the ACTUAL cluster watched: an omitted context and
  // an explicit context equal to defaultContext resolve to the same key, so they
  // share one watch (and prewarm warm-hits survive once the WS layer passes the
  // default context explicitly). Mirrors the resolution in buildArgs.
  private subKey(s: Sub): string {
    const ctx = s.context ?? this.defaultContext ?? "";
    return `${ctx}/${s.kind}/${s.namespace}`;
  }

  subscribe(
    sub: Sub,
    onSnapshot: (items: any[]) => void,
    onDelta: (e: WatchEvent) => void,
  ): () => void {
    const key = this.subKey(sub);
    let w = this.watches.get(key);
    if (!w) w = this.create(sub, key, false);

    // A new subscriber cancels any pending idle teardown.
    if (w.idleTimer) {
      clearTimeout(w.idleTimer);
      w.idleTimer = null;
    }
    const listener: Listener = { onSnapshot, onDelta };
    w.listeners.add(listener);

    // Warm hit: a ready watch serves its cache immediately. A not-yet-ready
    // watch (LIST in flight) snapshots this listener when the LIST completes,
    // because emitSnapshot iterates the current listener set at that moment.
    if (w.ready) onSnapshot([...w.cache.values()]);

    return () => {
      const cur = this.watches.get(key);
      if (!cur) return;
      cur.listeners.delete(listener);
      if (cur.listeners.size === 0 && !cur.pinned) this.scheduleIdleStop(key);
    };
  }

  // Start (or refresh) a pinned warm watch per kind with NO client listener.
  // Pinned watches keep their cache fresh from the delta stream, are never
  // idle-stopped, and serve an instant warm snapshot to the first real client.
  prewarm(kinds: string[], namespace = "*"): void {
    for (const kind of kinds) {
      const sub = { kind, namespace };
      const key = this.subKey(sub);
      const existing = this.watches.get(key);
      if (existing) {
        existing.pinned = true;
        continue;
      }
      this.create(sub, key, true);
    }
  }

  // Build the Watch record and kick off the LIST + watch-stream lifecycle.
  private create(sub: Sub, key: string, pinned: boolean): Watch {
    const w: Watch = {
      sub,
      cache: new Map<string, any>(),
      listeners: new Set<Listener>(),
      listProc: null,
      watchProc: null,
      ready: false,
      pinned,
      stopping: false,
      idleTimer: null,
      restartTimer: null,
      restarts: 0,
    };
    this.watches.set(key, w);
    this.startList(key);
    return w;
  }

  // Build the kubectl argv shared by the LIST and the watch stream.
  private buildArgs(sub: Sub, watchOnly: boolean): string[] {
    const context = sub.context ?? this.defaultContext;
    const nsArgs =
      sub.namespace === "*" ? ["--all-namespaces"] : ["-n", sub.namespace];
    return [
      "kubectl",
      ...(context ? ["--context", context] : []),
      "get",
      sub.kind,
      ...nsArgs,
      ...(watchOnly ? ["--watch-only", "--output-watch-events"] : []),
      "-o",
      "json",
    ];
  }

  // Phase 1: one-shot LIST for an authoritative snapshot, then the delta stream.
  private startList(key: string): void {
    const w = this.watches.get(key);
    if (!w) return;
    const argv = this.buildArgs(w.sub, false);
    const proc = this.spawnFn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "ignore"],
    });
    w.listProc = proc;

    let out = "";
    proc.stdout!.on("data", (buf: Buffer) => {
      out += buf.toString("utf8");
    });

    let settled = false;
    const onEnd = (code: number | null) => {
      if (settled) return;
      settled = true;
      w.listProc = null;
      if (this.watches.get(key) !== w || w.stopping) return;
      if (code === 0) {
        // Rebuild the cache from the listed items (authoritative). Deletes that
        // happened while we were down are reconciled by the fresh Map.
        const next = new Map<string, any>();
        try {
          const parsed = JSON.parse(out) as { items?: any[] };
          for (const item of parsed.items ?? []) {
            const name = item?.metadata?.name;
            if (name) next.set(name, item);
          }
        } catch {
          // Malformed JSON: treat as an empty authoritative list rather than
          // crashing. The watch stream will repopulate from live events.
        }
        w.cache = next;
        w.ready = true;
        w.restarts = 0; // a good LIST clears the backoff
        this.emitSnapshot(w);
        this.startWatchStream(key);
      } else {
        // The LIST failed (NotFound for a missing kind, or a transient error).
        // On the FIRST failure (never been ready) emit one empty snapshot so the
        // client renders empty instead of a forever spinner, and mark ready so
        // warm subscribers don't hang. On a later failure keep the last-known
        // cache (a transient hiccup shouldn't wipe good data) and don't re-emit.
        // Either way, retry on the capped backoff so the kind can self-heal.
        if (!w.ready) {
          w.cache = new Map<string, any>();
          w.ready = true;
          this.emitSnapshot(w);
        }
        this.scheduleRestart(key);
      }
    };

    proc.on("exit", (code) => onEnd(code));
    proc.on("close", (code) => onEnd(code));
    proc.on("error", () => onEnd(1)); // ENOENT etc: do not crash the server
  }

  // Phase 2: the long-lived delta stream. Each event updates the cache and is
  // forwarded to every listener (an empty listener set just keeps the cache hot).
  private startWatchStream(key: string): void {
    const w = this.watches.get(key);
    if (!w) return;
    const argv = this.buildArgs(w.sub, true);
    const proc = this.spawnFn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "ignore"],
    });
    w.watchProc = proc;
    const parser = new WatchEventParser();

    proc.stdout!.on("data", (buf: Buffer) => {
      parser.push(buf.toString("utf8"), (e) => {
        applyEvent(w.cache, e);
        for (const l of w.listeners) l.onDelta(e);
      });
    });

    const onDeath = () => {
      if (w.watchProc !== proc) return; // already replaced/torn down
      w.watchProc = null;
      if (this.watches.get(key) !== w || w.stopping) return;
      // The stream died on its own (server hiccup, reset). Resync via a full
      // restart (LIST + watch) so deletes during downtime are reconciled.
      this.scheduleRestart(key);
    };
    proc.on("exit", onDeath);
    proc.on("close", onDeath);
    proc.on("error", onDeath); // a failed delta stream is just another restart
  }

  // Re-run the LIST + watch lifecycle after an exponential backoff capped at
  // restartMaxMs. No hard attempt cap: the delay cap alone prevents a hot loop,
  // and retrying forever (slowly) lets a kind recover once it exists again.
  private scheduleRestart(key: string): void {
    const w = this.watches.get(key);
    if (!w || w.stopping || w.restartTimer) return;
    const attempt = Math.min(w.restarts, RESTART_MAX_EXP);
    w.restarts += 1;
    const delay = Math.min(
      this.restartBaseMs * 2 ** attempt,
      this.restartMaxMs,
    );
    w.restartTimer = setTimeout(() => {
      w.restartTimer = null;
      if (this.watches.get(key) !== w || w.stopping) return;
      this.startList(key);
    }, delay);
  }

  // Push a fresh authoritative snapshot to every current listener. Fired on the
  // first LIST and again on every restart/resync, so deletes during downtime
  // are reconciled. A pinned watch with zero listeners simply pushes to no one.
  private emitSnapshot(w: Watch): void {
    const items = [...w.cache.values()];
    for (const l of w.listeners) l.onSnapshot(items);
  }

  // Idle teardown: when the last listener leaves an unpinned watch, wait the TTL
  // before stopping. A new subscriber cancels the timer (see subscribe()).
  private scheduleIdleStop(key: string): void {
    const w = this.watches.get(key);
    if (!w || w.pinned || w.idleTimer) return;
    w.idleTimer = setTimeout(() => {
      const cur = this.watches.get(key);
      if (!cur) return;
      cur.idleTimer = null;
      if (cur.listeners.size === 0 && !cur.pinned) this.stop(key);
    }, this.idleTtlMs);
  }

  private stop(key: string): void {
    const w = this.watches.get(key);
    if (!w) return;
    w.stopping = true;
    if (w.idleTimer) clearTimeout(w.idleTimer);
    if (w.restartTimer) clearTimeout(w.restartTimer);
    w.listProc?.kill();
    w.watchProc?.kill();
    this.watches.delete(key);
  }
}
