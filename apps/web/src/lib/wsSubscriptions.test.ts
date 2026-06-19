import { describe, expect, test } from "vitest";
import {
  finishLinger,
  planSubscribe,
  planUnsubscribe,
  subKey,
  type SubRegistry,
} from "./wsSubscriptions";

function registry(): SubRegistry {
  return new Map();
}

describe("planSubscribe", () => {
  test("cold subscribe creates the entry, toggles loading, sends the frame", () => {
    const reg = registry();
    const r = planSubscribe(reg, "deployments", "default");
    expect(r).toEqual({ sendSubscribe: true, toggleLoading: true });
    const entry = reg.get(subKey("deployments", "default"));
    expect(entry).toMatchObject({ kind: "deployments", namespace: "default", refs: 1 });
  });

  test("warm reuse bumps refs, sends nothing, does not toggle loading", () => {
    const reg = registry();
    planSubscribe(reg, "deployments", "default");
    const r = planSubscribe(reg, "deployments", "default");
    expect(r.sendSubscribe).toBe(false);
    expect(r.toggleLoading).toBe(false);
    expect(reg.get(subKey("deployments", "default"))?.refs).toBe(2);
  });

  test("subscribe during linger cancels the timer and revives the entry", () => {
    const reg = registry();
    planSubscribe(reg, "deployments", "default");
    planUnsubscribe(reg, "deployments", "default"); // refs -> 0
    const entry = reg.get(subKey("deployments", "default"))!;
    const fakeTimer = setTimeout(() => {}, 1_000_000) as ReturnType<typeof setTimeout>;
    entry.lingerTimer = fakeTimer;

    const r = planSubscribe(reg, "deployments", "default");
    expect(r.sendSubscribe).toBe(false); // server still subscribed, no new frame
    expect(r.toggleLoading).toBe(false); // store still holds data, no flash
    expect(r.clearedTimer).toBe(fakeTimer); // caller clears it
    expect(entry.lingerTimer).toBeUndefined();
    expect(entry.refs).toBe(1);
    clearTimeout(fakeTimer);
  });

  test("namespaces are isolated", () => {
    const reg = registry();
    planSubscribe(reg, "pods", "default");
    const r = planSubscribe(reg, "pods", "kube-system");
    expect(r.sendSubscribe).toBe(true); // different ns is a cold subscribe
    expect(reg.size).toBe(2);
  });
});

describe("planUnsubscribe", () => {
  test("unknown entry is a no-op", () => {
    const reg = registry();
    expect(planUnsubscribe(reg, "pods", "default")).toEqual({ startLinger: false });
  });

  test("does not linger while other refs remain", () => {
    const reg = registry();
    planSubscribe(reg, "pods", "default");
    planSubscribe(reg, "pods", "default"); // refs 2 (e.g. ChatPane + panel)
    const r = planUnsubscribe(reg, "pods", "default");
    expect(r.startLinger).toBe(false);
    expect(reg.get(subKey("pods", "default"))?.refs).toBe(1);
  });

  test("lingers once the last ref is released", () => {
    const reg = registry();
    planSubscribe(reg, "pods", "default");
    const r = planUnsubscribe(reg, "pods", "default");
    expect(r.startLinger).toBe(true);
    expect(reg.get(subKey("pods", "default"))?.refs).toBe(0); // kept during linger
  });
});

describe("finishLinger", () => {
  test("deletes the entry and sends unsubscribe when still idle", () => {
    const reg = registry();
    planSubscribe(reg, "pods", "default");
    planUnsubscribe(reg, "pods", "default"); // refs -> 0
    const r = finishLinger(reg, "pods", "default");
    expect(r.sendUnsubscribe).toBe(true);
    expect(reg.has(subKey("pods", "default"))).toBe(false);
  });

  test("revived during the grace period: keep the entry, send nothing", () => {
    const reg = registry();
    planSubscribe(reg, "pods", "default");
    planUnsubscribe(reg, "pods", "default"); // refs -> 0
    planSubscribe(reg, "pods", "default"); // revive: refs -> 1
    const r = finishLinger(reg, "pods", "default");
    expect(r.sendUnsubscribe).toBe(false);
    expect(reg.get(subKey("pods", "default"))?.refs).toBe(1);
  });

  test("unknown entry is a no-op", () => {
    const reg = registry();
    expect(finishLinger(reg, "pods", "default")).toEqual({ sendUnsubscribe: false });
  });
});

describe("full lifecycle: tab switch reuses the warm watch", () => {
  test("subscribe, unsubscribe (linger), re-subscribe sends only one frame", () => {
    const reg = registry();
    // Panel mounts: cold subscribe, one frame.
    expect(planSubscribe(reg, "deployments", "default").sendSubscribe).toBe(true);
    // Tab switch unmounts the panel: last ref released, enters linger.
    expect(planUnsubscribe(reg, "deployments", "default").startLinger).toBe(true);
    // Switch back before the timer fires: warm reuse, no frame, no loading flash.
    const back = planSubscribe(reg, "deployments", "default");
    expect(back.sendSubscribe).toBe(false);
    expect(back.toggleLoading).toBe(false);
    // The (now stale) linger timer fires but the entry is in use, so no teardown.
    expect(finishLinger(reg, "deployments", "default").sendUnsubscribe).toBe(false);
    expect(reg.get(subKey("deployments", "default"))?.refs).toBe(1);
  });
});
