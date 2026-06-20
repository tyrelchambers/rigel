// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import HelmPanel from "./HelmPanel";

vi.mock("./ReleasesView", () => ({
  ReleasesView: ({ onUpgrade }: { onUpgrade: (r: unknown) => void }) => (
    <button onClick={() => onUpgrade({ name: "r", namespace: "default", chartName: "c" })}>upgrade</button>
  ),
}));
vi.mock("./BrowseChartsView", () => ({
  BrowseChartsView: ({ onPickChart }: { onPickChart: (c: unknown) => void }) => (
    <button onClick={() => onPickChart({ name: "loki", version: "1", source: { kind: "repo", repoName: "g", repoURL: "u", chart: "loki", version: "1" } })}>pick</button>
  ),
}));
vi.mock("./InstallChartView", () => ({
  InstallChartView: ({ chartPrefill }: { chartPrefill: { suggestedName: string } | null }) => (
    <div>install:{chartPrefill?.suggestedName ?? "none"}</div>
  ),
}));

describe("HelmPanel", () => {
  it("shows three tabs and routes a Browse pick into Install with prefill", () => {
    render(<HelmPanel />);
    expect(screen.getByRole("tab", { name: "Browse charts" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Browse charts" }));
    fireEvent.click(screen.getByText("pick"));
    expect(screen.getByText("install:loki")).toBeInTheDocument();
  });
});
