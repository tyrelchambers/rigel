// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CredentialsManager } from "./CredentialsManager";
import type { AssistantCredentials } from "@/lib/api";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/agents")) {
      return new Response(JSON.stringify({
        activeAgentId: "claude",
        agents: [
          { id: "claude", label: "Claude", vendor: "Anthropic", status: "available", connection: "connected", authMethods: ["subscription", "apiKey"], authMethod: "subscription", installUrl: "x", installLabel: "i" },
          { id: "codex", label: "Codex", vendor: "OpenAI", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
          { id: "gemini", label: "Gemini", vendor: "Google", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
          { id: "opencode", label: "OpenCode", vendor: "SST", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
        ],
      }));
    }
    return new Response(JSON.stringify({ models: [], efforts: [] }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("CredentialsManager", () => {
  it("renders a row per provider with vendor + auth-method label", async () => {
    wrap(<CredentialsManager credentials={{}} onSave={() => {}} />);
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Gemini")).toBeInTheDocument();
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    expect(screen.getByText("Subscription token or API key")).toBeInTheDocument();
    expect(screen.getAllByText("API key").length).toBeGreaterThanOrEqual(3);
  });

  it("shows 'Key ready' for a provider with a credential and 'Not set' otherwise", async () => {
    const creds: AssistantCredentials = { geminiApiKey: "g-1" };
    wrap(<CredentialsManager credentials={creds} onSave={() => {}} />);
    expect(await screen.findByText("Key ready")).toBeInTheDocument();
    expect(screen.getAllByText("Not set").length).toBeGreaterThanOrEqual(3);
  });

  it("notes the keys are stored as a Kubernetes Secret", async () => {
    wrap(<CredentialsManager credentials={{}} onSave={() => {}} />);
    expect(await screen.findByText(/Stored as a Kubernetes Secret/i)).toBeInTheDocument();
  });

  it("calls onSave(provider, value) when a key is entered and saved", async () => {
    const onSave = vi.fn();
    wrap(<CredentialsManager credentials={{}} onSave={onSave} />);
    // Open the Gemini row's inline editor.
    const geminiRow = (await screen.findByText("Gemini")).closest("[data-provider]") as HTMLElement;
    await userEvent.click(within(geminiRow).getByRole("button", { name: /add key/i }));
    await userEvent.type(within(geminiRow).getByPlaceholderText(/key/i), "g-secret");
    await userEvent.click(within(geminiRow).getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith("gemini", "g-secret");
  });
});

import { within } from "@testing-library/react";
