// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ActivityTab } from "./ActivityTab";
import * as ctx from "../AssistantContext";

function makeAudit(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    incident: `pod-${i}`,
    fingerprint: `loggedError|default|pod-${i}|r`,
    outcome: "skipped",
    tier: "low",
    detail: "",
  }));
}

function mockCtx(audit: unknown[]) {
  vi.spyOn(ctx, "useAssistantCtx").mockReturnValue({
    d: { clusterState: { audit }, backupYAML: () => undefined },
    openAllActivity: vi.fn(),
    run: vi.fn(),
    ns: "default",
    working: false,
    expanded: new Set<string>(),
    toggleExpanded: vi.fn(),
    openRevert: vi.fn(),
  } as unknown as ctx.AssistantContextValue);
}

afterEach(() => vi.restoreAllMocks());

describe("ActivityTab pagination", () => {
  it("pages through activity in blocks of ten", () => {
    mockCtx(makeAudit(124));
    render(<ActivityTab />);
    expect(screen.getByText("pod-0")).toBeInTheDocument();
    expect(screen.queryByText("pod-10")).toBeNull();
    expect(screen.getByText("1 / 13")).toBeInTheDocument();
    expect(screen.getByText(/of 124/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(screen.getByText("pod-10")).toBeInTheDocument();
    expect(screen.queryByText("pod-0")).toBeNull();
    expect(screen.getByText("2 / 13")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /previous page/i }));
    expect(screen.getByText("pod-0")).toBeInTheDocument();
  });

  it("shows no pager when there are ten or fewer entries", () => {
    mockCtx(makeAudit(5));
    render(<ActivityTab />);
    expect(screen.queryByRole("button", { name: /next page/i })).toBeNull();
  });
});
