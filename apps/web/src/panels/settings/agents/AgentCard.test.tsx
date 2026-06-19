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
});
