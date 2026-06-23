// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CredentialsManager } from "./CredentialsManager";
import type { AssistantCredentials, CredentialSourceStatus } from "@/lib/api";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function manager(over: Partial<React.ComponentProps<typeof CredentialsManager>> = {}) {
  return (
    <CredentialsManager
      credentials={{}}
      credentialSources={{}}
      namespace="default"
      onSave={() => {}}
      onSaveSource={() => {}}
      onUseManaged={() => {}}
      {...over}
    />
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/assistant")) {
      const body = JSON.parse((init?.body as string) ?? "{}") as { action?: string };
      if (body.action === "listCredentialSecrets") {
        return new Response(JSON.stringify({ success: true, stdout: JSON.stringify({ secrets: [] }), stderr: "" }));
      }
      return new Response(JSON.stringify({ success: true, stdout: "", stderr: "" }));
    }
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
    wrap(manager());
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Gemini")).toBeInTheDocument();
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    // Claude, Codex and OpenCode accept a subscription OR an API key; only Gemini is key-only.
    expect(screen.getAllByText("Subscription or API key")).toHaveLength(3);
    expect(screen.getAllByText("API key")).toHaveLength(1);
  });

  it("shows 'Key ready' from credentialSources readiness and 'Not set' otherwise", async () => {
    const sources: Partial<Record<keyof AssistantCredentials, CredentialSourceStatus>> = {
      geminiApiKey: { ready: true, secretName: "rigel-assistant-credentials" },
    };
    const creds: AssistantCredentials = { geminiApiKey: "set" };
    wrap(manager({ credentials: creds, credentialSources: sources }));
    expect(await screen.findByText("Key ready")).toBeInTheDocument();
    expect(screen.getAllByText("Not set").length).toBeGreaterThanOrEqual(3);
  });

  it("does NOT show the raw backing Secret name in the row's resting state", async () => {
    const sources: Partial<Record<keyof AssistantCredentials, CredentialSourceStatus>> = {
      claudeToken: { ready: true, secretName: "my-byo-secret" },
    };
    wrap(manager({ credentials: { claudeToken: "set" }, credentialSources: sources }));
    await screen.findByText("Claude");
    // The backing Secret name only appears inside the (closed) dialog, never the row.
    expect(screen.queryByText(/my-byo-secret/)).not.toBeInTheDocument();
  });

  it("notes the keys are stored as a Kubernetes Secret", async () => {
    wrap(manager());
    expect(await screen.findByText(/Stored as a Kubernetes Secret/i)).toBeInTheDocument();
  });

  it("the Source control opens the credential-source dialog (managed paste editor)", async () => {
    wrap(manager());
    const geminiRow = (await screen.findByText("Gemini")).closest("[data-provider]") as HTMLElement;
    await userEvent.click(within(geminiRow).getByRole("button", { name: /^source$/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Gemini credential source/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/credential value/i)).toBeInTheDocument();
  });

  it("a managed-mode save routes the pasted value through onSave(provider, key, value)", async () => {
    const onSave = vi.fn();
    wrap(manager({ onSave }));
    const geminiRow = (await screen.findByText("Gemini")).closest("[data-provider]") as HTMLElement;
    await userEvent.click(within(geminiRow).getByRole("button", { name: /^source$/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/credential value/i), "g-secret");
    await userEvent.click(within(dialog).getByRole("button", { name: /save & restart/i }));
    expect(onSave).toHaveBeenCalledWith("gemini", "geminiApiKey", "g-secret");
  });

  it("opens a help modal explaining how to authenticate the provider", async () => {
    wrap(manager());
    const claudeRow = (await screen.findByText("Claude")).closest("[data-provider]") as HTMLElement;
    await userEvent.click(within(claudeRow).getByRole("button", { name: /how to connect claude/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Use your subscription/i)).toBeInTheDocument();
    expect(within(dialog).getByText("claude setup-token")).toBeInTheDocument();
    expect(within(dialog).getByText(/Use an API key/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Kubernetes Secret/i)).toBeInTheDocument();
  });
});
