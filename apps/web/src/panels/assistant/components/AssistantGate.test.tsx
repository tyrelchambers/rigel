// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssistantGate } from "./AssistantGate";
import type { AssistantContextValue } from "../AssistantContext";

vi.mock("../AssistantContext", () => ({ useAssistantCtx: vi.fn() }));
import { useAssistantCtx } from "../AssistantContext";

vi.mock("@/shell/UpgradeContext", () => ({ useUpgrade: vi.fn() }));
import { useUpgrade } from "@/shell/UpgradeContext";

const openUpgrade = vi.fn();

function ctxWithAudit(count: number): AssistantContextValue {
  const audit = Array.from({ length: count }).map(() => ({}));
  return { d: { clusterState: count > 0 ? { audit } : null } } as unknown as AssistantContextValue;
}

beforeEach(() => {
  openUpgrade.mockReset();
  vi.mocked(useUpgrade).mockReturnValue({ openUpgrade });
});

describe("AssistantGate", () => {
  it("shows the incident count and masked rows (capped at 3)", () => {
    vi.mocked(useAssistantCtx).mockReturnValue(ctxWithAudit(5));
    render(<AssistantGate />);
    expect(screen.getByText(/detected 5 incidents/i)).toBeInTheDocument();
    expect(screen.getByText("5 new")).toBeInTheDocument();
    expect(screen.getAllByText("Degraded")).toHaveLength(3);
  });

  it("uses the watching copy and no masked rows when there are no incidents", () => {
    vi.mocked(useAssistantCtx).mockReturnValue(ctxWithAudit(0));
    render(<AssistantGate />);
    expect(screen.getByText(/watching your cluster in the background/i)).toBeInTheDocument();
    expect(screen.queryByText(/ new$/)).not.toBeInTheDocument();
    expect(screen.queryByText("Degraded")).not.toBeInTheDocument();
  });

  it("calls openUpgrade when Upgrade to Pro is clicked", async () => {
    vi.mocked(useAssistantCtx).mockReturnValue(ctxWithAudit(1));
    render(<AssistantGate />);
    await userEvent.click(screen.getByRole("button", { name: /upgrade to pro/i }));
    expect(openUpgrade).toHaveBeenCalled();
  });
});
