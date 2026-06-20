// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ArtifactHubChart } from "./helmApi";
import { BrowseChartsView } from "./BrowseChartsView";

const mockUse = vi.fn();
vi.mock("./helmApi", () => ({ useArtifactHubBrowse: (p: unknown) => mockUse(p) }));

const chart: ArtifactHubChart = {
  name: "loki",
  displayName: "Loki",
  version: "5.0.0",
  description: "Log aggregation",
  repoName: "grafana",
  logoURL: null,
  stars: 100,
  official: true,
  verifiedPublisher: true,
  source: { kind: "repo", repoName: "grafana", repoURL: "https://x", chart: "loki", version: "5.0.0" },
};

beforeEach(() => {
  mockUse.mockReset();
  mockUse.mockReturnValue({
    data: { pages: [{ items: [chart], total: 1 }] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
  });
});

describe("BrowseChartsView", () => {
  it("renders chart cards and fires onPickChart on click", () => {
    const onPick = vi.fn();
    render(<BrowseChartsView onPickChart={onPick} />);
    expect(screen.getByText("Loki")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Loki"));
    expect(onPick).toHaveBeenCalledWith(chart);
  });

  it("passes the Official filter to the hook when toggled", () => {
    render(<BrowseChartsView onPickChart={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Official" }));
    expect(mockUse).toHaveBeenLastCalledWith(expect.objectContaining({ official: true }));
  });
});
