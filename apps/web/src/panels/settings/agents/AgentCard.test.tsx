// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AgentCard } from "./AgentCard";
import type { AgentView } from "@/lib/api";

const base: AgentView = {
  id: "claude", label: "Claude Code", vendor: "Anthropic", status: "available",
  connection: "connected", authMethods: ["subscription", "apiKey"], authMethod: "subscription",
  installUrl: "https://x", installLabel: "Install",
};

describe("AgentCard", () => {
  it("shows the connection label and fires onOpen", () => {
    const onOpen = vi.fn();
    render(<AgentCard agent={base} onOpen={onOpen} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledWith("claude");
  });

  it("labels a coming-soon agent", () => {
    render(<AgentCard agent={{ ...base, id: "codex", status: "comingSoon", connection: "comingSoon" }} onOpen={() => {}} />);
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
  });

  it("never shows 'Active'; the selected agent gets only the blue-border treatment and keeps its connection label", () => {
    render(<AgentCard agent={base} isActive onOpen={() => {}} />);
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    // base.connection === "connected"
    expect(screen.getByText("Connected")).toBeInTheDocument();
    // Selected treatment: blue hover background, and NOT the neutral subtle border.
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("hover:bg-[var(--accent-dim)]");
    expect(btn.className).not.toContain("border-[var(--border-subtle)]");
  });

  it("shows a selected-but-not-installed agent as 'Not installed' (the fresh-install case), never 'Active'", () => {
    render(<AgentCard agent={{ ...base, connection: "notInstalled" }} isActive onOpen={() => {}} />);
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    expect(screen.getByText("Not installed")).toBeInTheDocument();
    // still marked as selected (blue treatment), just not connected
    expect(screen.getByRole("button").className).toContain("hover:bg-[var(--accent-dim)]");
  });

  it("labels an installed-but-unauthenticated agent 'Not signed in'", () => {
    render(<AgentCard agent={{ ...base, connection: "notSignedIn" }} onOpen={() => {}} />);
    expect(screen.getByText("Not signed in")).toBeInTheDocument();
  });

  it("gives an unselected card the neutral subtle border, not the blue treatment", () => {
    render(<AgentCard agent={base} onOpen={() => {}} />);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("border-[var(--border-subtle)]");
    expect(btn.className).not.toContain("hover:bg-[var(--accent-dim)]");
  });
});
