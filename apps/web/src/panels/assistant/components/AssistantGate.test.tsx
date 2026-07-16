// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssistantGate } from "./AssistantGate";

vi.mock("@/shell/UpgradeContext", () => ({ useUpgrade: vi.fn() }));
import { useUpgrade } from "@/shell/UpgradeContext";

const openUpgrade = vi.fn();

beforeEach(() => {
  openUpgrade.mockReset();
  vi.mocked(useUpgrade).mockReturnValue({ openUpgrade });
});

describe("AssistantGate", () => {
  it("shows the pitch and the Pro feature list", () => {
    render(<AssistantGate />);
    expect(screen.getByText("Let Rigel run your cluster")).toBeInTheDocument();
    expect(screen.getByText("Autonomous remediation")).toBeInTheDocument();
    expect(screen.getByText("Notifications")).toBeInTheDocument();
    expect(screen.getByText("Audits")).toBeInTheDocument();
  });

  it("calls openUpgrade when Upgrade to Pro is clicked", async () => {
    render(<AssistantGate />);
    await userEvent.click(screen.getByRole("button", { name: /upgrade to pro/i }));
    expect(openUpgrade).toHaveBeenCalled();
  });
});
