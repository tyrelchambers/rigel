// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NodeMetricsTable } from "./NodeMetricsTable";
import type { NodeResourceTotals } from "./overviewDisplay";

afterEach(cleanup);

const rows: NodeResourceTotals[] = [
  { name: "k3s-slave", cpuUsed: 0.946, cpuAllocatable: 8, cpuFraction: 0.12, memUsed: 9.7 * 2 ** 30, memAllocatable: 19 * 2 ** 30, memFraction: 0.51 },
  { name: "k8s-truenas", cpuUsed: 0.463, cpuAllocatable: 6, cpuFraction: 0.08, memUsed: 12.3 * 2 ** 30, memAllocatable: 15.1 * 2 ** 30, memFraction: 0.82 },
];

test("renders a row per node with name, percentages, and column heads", () => {
  render(<NodeMetricsTable rows={rows} readyByName={{ "k3s-slave": true, "k8s-truenas": true }} hasMetrics reclaimable={null} />);
  expect(screen.getByText("k3s-slave")).toBeTruthy();
  expect(screen.getByText("k8s-truenas")).toBeTruthy();
  expect(screen.getByText("12%")).toBeTruthy();
  expect(screen.getByText("51%")).toBeTruthy();
  expect(screen.getByText("82%")).toBeTruthy();
  expect(screen.getByText("NODE")).toBeTruthy();
  expect(screen.getByText("MEMORY")).toBeTruthy();
});

test("flags >=80% utilization with an amber fill, lower usage with the default fill", () => {
  const { container } = render(<NodeMetricsTable rows={rows} readyByName={{}} hasMetrics reclaimable={null} />);
  expect(container.querySelector(".ov-mtable-fill--warn")).toBeTruthy(); // 82% memory
  expect(container.querySelectorAll(".ov-mtable-fill:not(.ov-mtable-fill--warn)").length).toBeGreaterThan(0);
});

test("shows the metrics-server empty state when unavailable", () => {
  render(<NodeMetricsTable rows={[]} readyByName={{}} hasMetrics={false} reclaimable={null} />);
  expect(screen.getByText(/metrics-server unavailable/i)).toBeTruthy();
});

test("renders the reclaimable badge when provided", () => {
  render(<NodeMetricsTable rows={rows} readyByName={{}} hasMetrics reclaimable={{ fraction: 0.06, detail: "3.5Gi of 60.4Gi" }} />);
  expect(screen.getByText("Reclaimable")).toBeTruthy();
  expect(screen.getByText("6%")).toBeTruthy();
  expect(screen.getByText("3.5Gi of 60.4Gi")).toBeTruthy();
});
