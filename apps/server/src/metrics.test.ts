import { test, expect } from "vitest";
import {
  normalizeQuantity,
  parseKubectlTopLine,
  parseKubectlTopNodeLine,
  parseKubectlTopPods,
  parseKubectlTopNodes,
} from "./metrics";

// --- normalizeQuantity: CPU -------------------------------------------------

test("normalizeQuantity: CPU millicores pass through", () => {
  expect(normalizeQuantity("150m", "cpu")).toBe(150);
  expect(normalizeQuantity("0", "cpu")).toBe(0);
  expect(normalizeQuantity("1500m", "cpu")).toBe(1500);
});

test("normalizeQuantity: CPU whole cores → millicores", () => {
  expect(normalizeQuantity("1", "cpu")).toBe(1000);
  expect(normalizeQuantity("4", "cpu")).toBe(4000);
});

test("normalizeQuantity: CPU nanocores/microcores → millicores", () => {
  expect(normalizeQuantity("150000000n", "cpu")).toBe(150);
  expect(normalizeQuantity("150000u", "cpu")).toBe(150);
});

// --- normalizeQuantity: memory ---------------------------------------------

test("normalizeQuantity: memory binary suffixes → bytes", () => {
  expect(normalizeQuantity("32Mi", "memory")).toBe(32 * 1024 * 1024);
  expect(normalizeQuantity("1Gi", "memory")).toBe(1024 * 1024 * 1024);
  expect(normalizeQuantity("512Ki", "memory")).toBe(512 * 1024);
});

test("normalizeQuantity: memory decimal suffixes → bytes", () => {
  expect(normalizeQuantity("1M", "memory")).toBe(1_000_000);
  expect(normalizeQuantity("1G", "memory")).toBe(1_000_000_000);
});

test("normalizeQuantity: malformed / empty → 0", () => {
  expect(normalizeQuantity("", "cpu")).toBe(0);
  expect(normalizeQuantity("<unknown>", "memory")).toBe(0);
  expect(normalizeQuantity("garbage", "memory")).toBe(0);
});

// --- parseKubectlTopLine (pods) --------------------------------------------

test("parseKubectlTopLine: --all-namespaces 4-column line", () => {
  const row = parseKubectlTopLine("default     nginx-abc123   150m   32Mi");
  expect(row).toEqual({
    namespace: "default",
    name: "nginx-abc123",
    cpu: "150",
    memory: "32Mi",
  });
});

test("parseKubectlTopLine: single-namespace 3-column line uses default ns", () => {
  const row = parseKubectlTopLine("nginx-abc123   2   1Gi", "kube-system");
  expect(row).toEqual({
    namespace: "kube-system",
    name: "nginx-abc123",
    cpu: "2000",
    memory: "1024Mi",
  });
});

test("parseKubectlTopLine: blank/malformed → null", () => {
  expect(parseKubectlTopLine("")).toBeNull();
  expect(parseKubectlTopLine("   ")).toBeNull();
  // 3 columns without a default namespace is ambiguous → null
  expect(parseKubectlTopLine("nginx 150m 32Mi")).toBeNull();
});

test("parseKubectlTopPods: parses multi-line output, skipping blanks", () => {
  const out = [
    "default   web-1   250m   128Mi",
    "default   web-2   0      64Mi",
    "",
    "kube-system   coredns-x   5m   16Mi",
  ].join("\n");
  const rows = parseKubectlTopPods(out);
  expect(rows).toHaveLength(3);
  expect(rows[0].name).toBe("web-1");
  expect(rows[2].namespace).toBe("kube-system");
});

// --- nodes ------------------------------------------------------------------

test("parseKubectlTopNodeLine: NAME CPU CPU% MEM MEM%", () => {
  const row = parseKubectlTopNodeLine("node-1   1200m   30%   4096Mi   50%");
  expect(row).toEqual({ name: "node-1", cpu: "1200", memory: "4096Mi" });
});

test("parseKubectlTopNodes: parses multi-line node output", () => {
  const out = [
    "node-1   1200m   30%   4096Mi   50%",
    "node-2   800m    20%   2048Mi   25%",
  ].join("\n");
  const rows = parseKubectlTopNodes(out);
  expect(rows).toHaveLength(2);
  expect(rows[1].name).toBe("node-2");
  expect(rows[1].memory).toBe("2048Mi");
});
