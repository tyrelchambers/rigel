import { test, expect } from "vitest";
import { stripStatusBlock } from "./manifestClean";

test("stripStatusBlock drops a top-level status block, keeps the rest", () => {
  const input = [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: web",
    "spec:",
    "  replicas: 2",
    "status:",
    "  readyReplicas: 2",
    "  conditions:",
    "  - type: Available",
  ].join("\n");
  const out = stripStatusBlock(input);
  expect(out).toContain("kind: Deployment");
  expect(out).toContain("replicas: 2");
  expect(out).not.toContain("status:");
  expect(out).not.toContain("readyReplicas");
});

test("stripStatusBlock keeps a status block that ends before another top-level key", () => {
  const input = ["kind: Deployment", "status:", "  ready: 1", "spec:", "  replicas: 3"].join("\n");
  const out = stripStatusBlock(input);
  expect(out).not.toContain("ready: 1");
  expect(out).toContain("replicas: 3"); // spec after status survives
});

test("stripStatusBlock leaves an indented status: key (e.g. configmap data) untouched", () => {
  const input = "apiVersion: v1\nkind: ConfigMap\ndata:\n  status: not-a-block\n";
  expect(stripStatusBlock(input)).toBe(input);
});

test("stripStatusBlock preserves the trailing newline when status is the final block", () => {
  const input = "kind: Deployment\nspec:\n  replicas: 1\nstatus:\n  readyReplicas: 1\n";
  expect(stripStatusBlock(input)).toBe("kind: Deployment\nspec:\n  replicas: 1\n");
});
