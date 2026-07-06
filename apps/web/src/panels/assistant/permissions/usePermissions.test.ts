// @vitest-environment jsdom
import { describe, test, expect } from "vitest";
import { stagedDiff } from "./usePermissions";
import { DEFAULT_POLICY, setCapability } from "@rigel/k8s";

test("stagedDiff reports pending changes vs the applied policy", () => {
  const next = setCapability(DEFAULT_POLICY, "deleteWorkloads", true);
  const d = stagedDiff(DEFAULT_POLICY, next);
  expect(d.count).toBeGreaterThan(0);
  expect(d.added.length).toBeGreaterThan(0);
  const none = stagedDiff(DEFAULT_POLICY, DEFAULT_POLICY);
  expect(none.count).toBe(0);
});

describe("stagedDiff", () => {
  test("counts both additions and removals", () => {
    const removedRead = { cells: DEFAULT_POLICY.cells.slice(1) };
    const d = stagedDiff(DEFAULT_POLICY, removedRead);
    expect(d.removed).toEqual([DEFAULT_POLICY.cells[0]]);
    expect(d.count).toBe(1);
  });
});
