import { beforeEach, describe, expect, it } from "vitest";
import { useNavHistoryStore, type NavEntry } from "./navHistory";

function entry(path: string, context = "prod", namespace: string | null = null): NavEntry {
  return { path, context, namespace, focus: null };
}

function reset() {
  useNavHistoryStore.setState({ entries: [], index: -1, pendingTarget: null });
}

const s = () => useNavHistoryStore.getState();

describe("navHistory store", () => {
  beforeEach(reset);

  it("appends entries and advances the index", () => {
    s().push(entry("/pods"));
    s().push(entry("/deployments"));
    expect(s().entries.map((e) => e.path)).toEqual(["/pods", "/deployments"]);
    expect(s().index).toBe(1);
  });

  it("dedupes an identical current signature", () => {
    s().push(entry("/pods"));
    s().push(entry("/pods"));
    expect(s().entries).toHaveLength(1);
    expect(s().index).toBe(0);
  });

  it("treats a different namespace as a new entry", () => {
    s().push(entry("/pods", "prod", null));
    s().push(entry("/pods", "prod", "web"));
    expect(s().entries).toHaveLength(2);
  });

  it("truncates forward history when pushing after stepBack", () => {
    s().push(entry("/pods"));
    s().push(entry("/deployments"));
    s().push(entry("/logs"));
    s().stepBack();
    s().push(entry("/deployments"));
    s().push(entry("/secrets"));
    expect(s().entries.map((e) => e.path)).toEqual(["/pods", "/deployments", "/secrets"]);
    expect(s().index).toBe(2);
  });

  it("stepBack/stepForward move the index and return entries; null at the ends", () => {
    s().push(entry("/a"));
    s().push(entry("/b"));
    expect(s().stepForward()).toBeNull();
    const back = s().stepBack();
    expect(back?.path).toBe("/a");
    expect(s().index).toBe(0);
    expect(s().stepBack()).toBeNull();
    s().push(entry("/a"));
    const fwd = s().stepForward();
    expect(fwd?.path).toBe("/b");
    expect(s().index).toBe(1);
  });

  it("pendingTarget guard: matching push clears it and records nothing", () => {
    s().push(entry("/a"));
    s().push(entry("/b"));
    s().stepBack();
    expect(s().pendingTarget).not.toBeNull();
    s().push(entry("/a"));
    expect(s().pendingTarget).toBeNull();
    expect(s().entries).toHaveLength(2);
    expect(s().index).toBe(0);
  });

  it("pendingTarget guard: a non-matching push while pending is ignored", () => {
    s().push(entry("/a"));
    s().push(entry("/b"));
    s().stepBack();
    s().push(entry("/mid"));
    expect(s().pendingTarget).not.toBeNull();
    expect(s().entries).toHaveLength(2);
    expect(s().index).toBe(0);
  });
});
