// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RolePicker } from "./RolePicker";
import type { AssistantRoleSelection } from "@/lib/api";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  // useAgentModels(provider) → GET /api/agents/<id>/models
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/agents/claude/models")) {
      return new Response(JSON.stringify({ models: ["claude-sonnet-4-6", "claude-opus-4-8"], efforts: ["low", "medium", "high"] }));
    }
    if (url.includes("/api/agents/gemini/models")) {
      return new Response(JSON.stringify({ models: ["gemini-2.5-pro", "gemini-2.5-flash"], efforts: [] }));
    }
    return new Response(JSON.stringify({ models: [], efforts: [] }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

const claudeValue: AssistantRoleSelection = { provider: "claude", model: "claude-sonnet-4-6", effort: "high" };

describe("RolePicker", () => {
  it("renders the role label, description, current provider and model", async () => {
    wrap(<RolePicker label="Worker" description="Investigates incidents, proposes fixes" value={claudeValue} onChange={() => {}} />);
    expect(screen.getByText("Worker")).toBeInTheDocument();
    expect(screen.getByText(/Investigates incidents/)).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(await screen.findByText("claude-sonnet-4-6")).toBeInTheDocument();
  });

  it("shows the reasoning-effort segment for Claude", async () => {
    wrap(<RolePicker label="Worker" description="d" value={claudeValue} onChange={() => {}} />);
    expect(await screen.findByRole("tab", { name: /low/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /medium/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /high/i })).toBeInTheDocument();
  });

  it("hides the effort segment for non-Claude providers", async () => {
    const gemini: AssistantRoleSelection = { provider: "gemini", model: "gemini-2.5-pro" };
    wrap(<RolePicker label="Worker" description="d" value={gemini} onChange={() => {}} />);
    await screen.findByText("gemini-2.5-pro");
    expect(screen.queryByRole("tab", { name: /low/i })).not.toBeInTheDocument();
  });

  it("emits a new selection with the first model when the provider changes", async () => {
    const onChange = vi.fn();
    wrap(<RolePicker label="Worker" description="d" value={claudeValue} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /provider/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /gemini/i }));
    // provider switched → model resets to gemini's first advertised model, effort cleared.
    expect(onChange).toHaveBeenCalledWith({ provider: "gemini", model: "gemini-2.5-pro" });
  });

  it("emits the chosen effort when an effort tab is clicked", async () => {
    const onChange = vi.fn();
    wrap(<RolePicker label="Worker" description="d" value={claudeValue} onChange={onChange} />);
    await userEvent.click(await screen.findByRole("tab", { name: /low/i }));
    expect(onChange).toHaveBeenCalledWith({ provider: "claude", model: "claude-sonnet-4-6", effort: "low" });
  });
});
