// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentSetup } from "./AgentSetup";
import type { AgentView } from "@/lib/api";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const claude: AgentView = {
  id: "claude", label: "Claude Code", vendor: "Anthropic", status: "available",
  connection: "notConnected", authMethods: ["subscription", "apiKey"], authMethod: "subscription",
  installUrl: "https://x", installLabel: "Install Claude Code",
};

describe("AgentSetup", () => {
  it("enables Save for an available agent", () => {
    wrap(<AgentSetup agent={claude} onBack={() => {}} />);
    expect(screen.getByRole("button", { name: /save/i })).not.toBeDisabled();
  });

  it("disables Save and shows a notice for a coming-soon agent", () => {
    wrap(<AgentSetup agent={{ ...claude, id: "codex", status: "comingSoon", connection: "comingSoon" }} onBack={() => {}} />);
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });
});
