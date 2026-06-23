// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
  it("renders a row per provider with vendor + data-driven auth summary", async () => {
    wrap(<CredentialsManager credentials={{}} onSave={() => {}} />);
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Gemini")).toBeInTheDocument();
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    // Claude + OpenCode accept a subscription OR an API key; Codex + Gemini are key-only.
    expect(screen.getAllByText("Subscription or API key")).toHaveLength(2);
    expect(screen.getAllByText("API key")).toHaveLength(2);
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

  it("calls onSave(provider, key, value) routing a key-only provider to its Secret key", async () => {
    const onSave = vi.fn();
    wrap(<CredentialsManager credentials={{}} onSave={onSave} />);
    const geminiRow = (await screen.findByText("Gemini")).closest("[data-provider]") as HTMLElement;
    await userEvent.click(within(geminiRow).getByRole("button", { name: /add key/i }));
    await userEvent.type(within(geminiRow).getByLabelText(/credential value/i), "g-secret");
    await userEvent.click(within(geminiRow).getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith("gemini", "geminiApiKey", "g-secret");
  });

  it("routes Claude to the subscription token by default and to the API key when the toggle is switched", async () => {
    const onSave = vi.fn();
    wrap(<CredentialsManager credentials={{}} onSave={onSave} />);
    const claudeRow = (await screen.findByText("Claude")).closest("[data-provider]") as HTMLElement;
    await userEvent.click(within(claudeRow).getByRole("button", { name: /add key/i }));

    // Default (Subscription) → claudeToken.
    await userEvent.type(within(claudeRow).getByLabelText(/credential value/i), "tok-1");
    await userEvent.click(within(claudeRow).getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenLastCalledWith("claude", "claudeToken", "tok-1");

    // Switch to API key → anthropicApiKey.
    await userEvent.click(within(claudeRow).getByRole("button", { name: /add key/i }));
    await userEvent.click(within(claudeRow).getByRole("tab", { name: /api key/i }));
    await userEvent.type(within(claudeRow).getByLabelText(/credential value/i), "sk-ant-2");
    await userEvent.click(within(claudeRow).getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenLastCalledWith("claude", "anthropicApiKey", "sk-ant-2");
  });

  it("opens a help modal explaining how to authenticate the provider", async () => {
    wrap(<CredentialsManager credentials={{}} onSave={() => {}} />);
    const claudeRow = (await screen.findByText("Claude")).closest("[data-provider]") as HTMLElement;
    await userEvent.click(within(claudeRow).getByRole("button", { name: /how to connect claude/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Use your subscription/i)).toBeInTheDocument();
    expect(within(dialog).getByText("claude setup-token")).toBeInTheDocument();
    expect(within(dialog).getByText(/Use an API key/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Kubernetes Secret/i)).toBeInTheDocument();
  });
});
