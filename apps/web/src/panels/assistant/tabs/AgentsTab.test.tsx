// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentsTab } from "./AgentsTab";
import { AssistantContext, type AssistantContextValue } from "../AssistantContext";
import type { AssistantDerived } from "../useAssistant";

const run = vi.fn();

function derived(overrides: Partial<AssistantDerived> = {}): AssistantDerived {
  return {
    roles: {
      worker: { provider: "claude", model: "claude-sonnet-4-6", effort: "high" },
      supervisor: { provider: "claude", model: "claude-opus-4-8", effort: "high" },
    },
    limits: { pollIntervalMs: 30000, confirmPolls: 2, namespaces: ["default"] },
    creds: {},
    credentialSources: {},
    ...overrides,
  } as AssistantDerived;
}

function ctx(d: AssistantDerived): AssistantContextValue {
  return { d, ns: "default", working: false, run } as unknown as AssistantContextValue;
}

function wrap(d = derived()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssistantContext value={ctx(d)}>
        <AgentsTab />
      </AssistantContext>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  run.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/assistant")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as { action?: string };
      if (body.action === "listCredentialSecrets") {
        return new Response(JSON.stringify({
          success: true,
          stdout: JSON.stringify({ secrets: [{ name: "my-anthropic-secret", type: "Opaque", keys: ["api-key"] }] }),
          stderr: "",
        }));
      }
      return new Response(JSON.stringify({ success: true, stdout: "", stderr: "" }));
    }
    if (url.includes("/api/agents/claude/models")) return new Response(JSON.stringify({ models: ["claude-sonnet-4-6", "claude-opus-4-8"], efforts: ["low", "medium", "high"] }));
    if (url.includes("/api/agents")) return new Response(JSON.stringify({ activeAgentId: "claude", agents: [
      { id: "claude", label: "Claude", vendor: "Anthropic", status: "available", connection: "connected", authMethods: ["subscription", "apiKey"], authMethod: "subscription", installUrl: "x", installLabel: "i" },
      { id: "codex", label: "Codex", vendor: "OpenAI", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
      { id: "gemini", label: "Gemini", vendor: "Google", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
      { id: "opencode", label: "OpenCode", vendor: "SST", status: "available", connection: "notConnected", authMethods: ["apiKey"], authMethod: "apiKey", installUrl: "x", installLabel: "i" },
    ] }));
    return new Response(JSON.stringify({ models: [], efforts: [] }));
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("AgentsTab", () => {
  it("renders the header, the two role cards, and the live-vs-restart note", async () => {
    wrap();
    expect(screen.getByText("Agents & providers")).toBeInTheDocument();
    expect(screen.getByText("Worker")).toBeInTheDocument();
    expect(screen.getByText("Supervisor")).toBeInTheDocument();
    expect(await screen.findByText(/Model changes apply on the next poll/i)).toBeInTheDocument();
  });

  it("saves a role change via setModels (live, no restart)", async () => {
    wrap();
    await screen.findAllByText("claude-sonnet-4-6");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      action: "setModels",
      namespace: "default",
      worker: expect.objectContaining({ provider: "claude" }),
      supervisor: expect.objectContaining({ provider: "claude" }),
    }));
  });

  it("pasting a credential (managed mode) confirms (rollout-restart) then calls setCredentials", async () => {
    wrap();
    const geminiRow = (await screen.findByText("Gemini")).closest("[data-provider]") as HTMLElement;
    await userEvent.click(within(geminiRow).getByRole("button", { name: /^source$/i }));
    const sourceDialog = await screen.findByRole("dialog");
    await userEvent.type(within(sourceDialog).getByLabelText(/credential value/i), "g-secret");
    await userEvent.click(within(sourceDialog).getByRole("button", { name: /save & restart/i }));
    // The restart-confirm dialog explains the restart; confirm it.
    await userEvent.click(await screen.findByRole("button", { name: /save & restart/i }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "setCredentials",
        namespace: "default",
        credentials: { geminiApiKey: "g-secret" },
      }),
      expect.any(Function),
    );
  });

  it("pointing at an existing Secret confirms then calls setCredentialSource", async () => {
    const { container } = wrap();
    // The credentials row is uniquely identified by data-provider (the RolePicker
    // dropdowns also render "Claude", so match on the row, not the label text).
    await screen.findByText("Agents & providers");
    const claudeRow = container.querySelector('[data-provider="claude"]') as HTMLElement;
    await userEvent.click(within(claudeRow).getByRole("button", { name: /^source$/i }));
    const sourceDialog = await screen.findByRole("dialog");
    await userEvent.click(within(sourceDialog).getByRole("tab", { name: /existing secret/i }));
    await userEvent.click(within(sourceDialog).getByRole("button", { name: /^secret$/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "my-anthropic-secret" }));
    await userEvent.click(within(sourceDialog).getByRole("button", { name: /^key$/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "api-key" }));
    await userEvent.click(within(sourceDialog).getByRole("button", { name: /save & restart/i }));
    // The restart-confirm dialog; confirm it.
    await userEvent.click(await screen.findByRole("button", { name: /save & restart/i }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "setCredentialSource",
        namespace: "default",
        credentialId: "claudeToken",
        secretName: "my-anthropic-secret",
        dataKey: "api-key",
      }),
      expect.any(Function),
    );
  });
});
