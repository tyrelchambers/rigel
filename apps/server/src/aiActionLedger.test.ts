import { describe, it, expect, vi } from "vitest";
import {
  AI_ACTIONS_MAX,
  appendAiAction,
  buildAiActionEntry,
  type AiActionEntry,
} from "@rigel/k8s/src/aiActionLedger";
import type { RunResult } from "@rigel/k8s/src/run";
import { recordAiAction, type AiActionLedgerDeps } from "./aiActionLedger";
import type { ActionBlock } from "./actions";

const OK: RunResult = { code: 0, stdout: "", stderr: "" };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * A ledger whose read and write are separated by real async gaps, so an
 * unserialized read-modify-write would lose every concurrent update.
 */
function fakeLedger(over: Partial<AiActionLedgerDeps> = {}) {
  const state = { entries: [] as AiActionEntry[] };
  const calls = { load: 0, save: 0 };
  const deps: AiActionLedgerDeps = {
    async load() {
      calls.load++;
      await tick();
      return [...state.entries];
    },
    async save(_ctx, entries) {
      calls.save++;
      await tick();
      state.entries = [...entries];
      return OK;
    },
    log: () => {},
    ...over,
  };
  return { state, calls, deps };
}

const entry = (id: string): AiActionEntry => ({
  id,
  at: "2026-08-17T00:00:00.000Z",
  source: "chat",
  kind: "Restarted",
  target: { kind: "Deployment", name: "api", namespace: "default" },
  command: "kubectl rollout restart deployment/api -n default",
  outcome: "success",
});

describe("recordAiAction serialization", () => {
  it("keeps every entry when 20 appends are fired concurrently", async () => {
    const { state, deps } = fakeLedger();
    const ids = Array.from({ length: 20 }, (_, i) => `e${i}`);

    await Promise.all(ids.map((id) => recordAiAction(null, entry(id), deps)));

    expect(state.entries).toHaveLength(20);
    expect(new Set(state.entries.map((e) => e.id)).size).toBe(20);
  });

  it("orders concurrent appends newest-first in submission order", async () => {
    const { state, deps } = fakeLedger();
    const ids = Array.from({ length: 12 }, (_, i) => `e${i}`);

    await Promise.all(ids.map((id) => recordAiAction(null, entry(id), deps)));

    expect(state.entries.map((e) => e.id)).toEqual([...ids].reverse());
  });

  it("never interleaves a read between another append's read and write", async () => {
    const order: string[] = [];
    const { deps } = fakeLedger({
      async load() {
        order.push("load");
        await tick();
        return [];
      },
      async save() {
        order.push("save");
        await tick();
        return OK;
      },
    });

    await Promise.all([
      recordAiAction(null, entry("a"), deps),
      recordAiAction(null, entry("b"), deps),
      recordAiAction(null, entry("c"), deps),
    ]);

    expect(order).toEqual(["load", "save", "load", "save", "load", "save"]);
  });

  it("truncates to the cap under concurrency, keeping the newest", async () => {
    const { state, deps } = fakeLedger();
    const total = AI_ACTIONS_MAX + 5;
    const ids = Array.from({ length: total }, (_, i) => `e${i}`);

    await Promise.all(ids.map((id) => recordAiAction(null, entry(id), deps)));

    expect(state.entries).toHaveLength(AI_ACTIONS_MAX);
    expect(state.entries[0]!.id).toBe(`e${total - 1}`);
    expect(state.entries.at(-1)!.id).toBe("e5");
  });

  it("preserves entries already in the ledger", async () => {
    const { state, deps } = fakeLedger();
    state.entries = [entry("pre-1"), entry("pre-2")];

    await Promise.all([recordAiAction(null, entry("a"), deps), recordAiAction(null, entry("b"), deps)]);

    expect(state.entries.map((e) => e.id)).toEqual(["b", "a", "pre-1", "pre-2"]);
  });

  it("does not stall the queue when one write fails", async () => {
    let saves = 0;
    const state: AiActionEntry[] = [];
    const deps: AiActionLedgerDeps = {
      async load() {
        await tick();
        return [...state];
      },
      async save(_ctx, entries) {
        saves++;
        await tick();
        if (saves === 1) return { code: 1, stdout: "", stderr: "Forbidden" };
        state.length = 0;
        state.push(...entries);
        return OK;
      },
      log: () => {},
    };

    const results = await Promise.all([
      recordAiAction(null, entry("a"), deps),
      recordAiAction(null, entry("b"), deps),
    ]);

    expect(results[0]).toEqual({ ok: false, message: "Forbidden" });
    expect(results[1]!.ok).toBe(true);
    expect(state.map((e) => e.id)).toEqual(["b"]);
  });

  it("does not stall the queue when one load throws", async () => {
    let loads = 0;
    const state: AiActionEntry[] = [];
    const deps: AiActionLedgerDeps = {
      async load() {
        loads++;
        await tick();
        if (loads === 1) throw new Error("connection refused");
        return [...state];
      },
      async save(_ctx, entries) {
        state.length = 0;
        state.push(...entries);
        return OK;
      },
      log: () => {},
    };

    const results = await Promise.all([
      recordAiAction(null, entry("a"), deps),
      recordAiAction(null, entry("b"), deps),
    ]);

    expect(results[0]).toEqual({ ok: false, message: "connection refused" });
    expect(results[1]!.ok).toBe(true);
    expect(state.map((e) => e.id)).toEqual(["b"]);
  });
});

describe("recordAiAction failure handling", () => {
  it("reports and logs a non-zero write without throwing", async () => {
    const log = vi.fn();
    const { deps } = fakeLedger({
      log,
      async save() {
        return { code: 1, stdout: "", stderr: "Error from server (Forbidden)" };
      },
    });

    await expect(recordAiAction(null, entry("a"), deps)).resolves.toEqual({
      ok: false,
      message: "Error from server (Forbidden)",
    });
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]![0])).toContain("Forbidden");
  });

  it("reports and logs a thrown load without throwing", async () => {
    const log = vi.fn();
    const { deps } = fakeLedger({
      log,
      async load() {
        throw new Error("kubectl not found");
      },
    });

    await expect(recordAiAction(null, entry("a"), deps)).resolves.toEqual({
      ok: false,
      message: "kubectl not found",
    });
    expect(log).toHaveBeenCalledOnce();
  });
});

describe("ActionBlock as a ledger subject", () => {
  it("builds an entry straight from an ActionBlock", () => {
    const action: ActionBlock = {
      kind: "scale",
      label: "Scale web to 5",
      name: "web",
      namespace: "prod",
      replicas: 5,
    };
    const built = buildAiActionEntry({
      action,
      source: "voice",
      command: "kubectl scale deployment/web --replicas=5 -n prod",
      outcome: "success",
    });
    expect(built.kind).toBe("Scaled");
    expect(built.source).toBe("voice");
    expect(built.target).toEqual({ kind: "Deployment", name: "web", namespace: "prod" });
    expect(built.trigger).toBe("Scale web to 5");
  });

  it("agrees with the pure appender on cap behaviour", () => {
    let list: AiActionEntry[] = [];
    for (let i = 0; i < 3; i++) list = appendAiAction(list, entry(`e${i}`), 2);
    expect(list.map((e) => e.id)).toEqual(["e2", "e1"]);
  });
});
