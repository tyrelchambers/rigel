// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { MemoryRouter } from "react-router";
import { RecentActivityCard } from "./RecentActivityCard";
import * as ctx from "../AssistantContext";

const navigate = vi.fn();
vi.mock("react-router", async (orig) => ({
  ...(await orig<typeof import("react-router")>()),
  useNavigate: () => navigate,
}));

function mockCtx(setTab = vi.fn(), run = vi.fn()) {
  vi.spyOn(ctx, "useAssistantCtx").mockReturnValue({
    run,
    ns: "default",
    setTab,
  } as unknown as ctx.AssistantContextValue);
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    at: new Date(2026, 0, 1).toISOString(),
    incident: "canadahires-api-7845596fdb-xr9vp",
    fingerprint: "loggedError|default|canadahires-api-7845596fdb-xr9vp|error-burst",
    outcome: "skipped",
    tier: "low",
    analysis:
      "Root cause is a bad date in the DB.\n\n**Fix:** edit the secret.\n\n```sh\nkubectl edit secret rigel-api -n default\n```",
    detail: "ERROR bad date\nsecond line",
    ...overrides,
  } as never;
}

afterEach(() => vi.restoreAllMocks());

function wrap(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("RecentActivityCard", () => {
  it("shows namespace, name and condition, and expands to analysis + resolution", () => {
    mockCtx();
    wrap(<RecentActivityCard e={entry()} />);
    expect(screen.getByText("default")).toBeInTheDocument();
    expect(screen.getByText("canadahires-api-7845596fdb-xr9vp")).toBeInTheDocument();
    expect(screen.getByText("Error burst")).toBeInTheDocument();
    // Collapsed: the AI-analysis body block is not rendered yet.
    expect(screen.queryByText(/AI analysis/i)).toBeNull();

    fireEvent.click(screen.getByText("canadahires-api-7845596fdb-xr9vp"));
    expect(screen.getByText(/AI analysis/i)).toBeInTheDocument();
    expect(screen.getByText(/root cause is a bad date/i)).toBeInTheDocument();
    // The synopsis renders as markdown: the fenced command becomes a code block.
    expect(screen.getByText(/kubectl edit secret rigel-api/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open in pods/i })).toBeInTheDocument();
  });

  it("offers a Review fix action for a queued incident", () => {
    const setTab = vi.fn();
    mockCtx(setTab);
    wrap(<RecentActivityCard e={entry({ outcome: "queued", proposal: "restart the pod" })} />);
    fireEvent.click(screen.getByText("canadahires-api-7845596fdb-xr9vp"));
    const btn = screen.getByRole("button", { name: /review fix/i });
    fireEvent.click(btn);
    expect(setTab).toHaveBeenCalledWith("needs");
  });
});
