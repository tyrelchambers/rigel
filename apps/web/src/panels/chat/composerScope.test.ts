import { test, expect } from "vitest";
import { scopeLabel, scopeToWire, DEFAULT_SCOPE, type ScopeSelection } from "./composerScope";

test("scopeToWire maps the UI selection to the server wire shape", () => {
  expect(scopeToWire({ mode: "active", picked: [] })).toBe("active");
  expect(scopeToWire({ mode: "all", picked: [] })).toBe("all");
  expect(scopeToWire({ mode: "pick", picked: ["prod", "stage"] })).toEqual({ contexts: ["prod", "stage"] });
  expect(scopeToWire({ mode: "pick", picked: [] })).toBe("active");
});

test("scopeLabel summarizes the selection", () => {
  expect(scopeLabel({ mode: "active", picked: [] })).toBe("Active cluster");
  expect(scopeLabel({ mode: "all", picked: [] })).toBe("All clusters");
  expect(scopeLabel({ mode: "pick", picked: ["a"] })).toBe("1 cluster");
  expect(scopeLabel({ mode: "pick", picked: ["a", "b"] })).toBe("2 clusters");
  expect(scopeLabel({ mode: "pick", picked: [] })).toBe("Pick clusters");
});

test("DEFAULT_SCOPE is active", () => {
  expect(DEFAULT_SCOPE).toEqual({ mode: "active", picked: [] } satisfies ScopeSelection);
});
