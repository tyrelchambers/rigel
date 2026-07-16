// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InstallView } from "./InstallView";
import { AssistantContext, type AssistantContextValue } from "../AssistantContext";

const agentToken = vi.fn(async (_orgId: string) => ({ token: "rig_agent_tok", installId: "inst-1" }) as { token: string; installId: string } | null);
let mockOrgs: Array<{ id: string; kind: "personal" | "team"; name: string; role: string }> = [];

vi.mock("@/lib/desktop", () => ({
  rigel: { billing: { agentToken: (orgId: string) => agentToken(orgId) } },
  isDesktop: true,
  isMacDesktop: false,
}));
vi.mock("@/shell/useAccount", () => ({ useAccount: () => ({ orgs: mockOrgs }) }));

const run = vi.fn();

function ctx(): AssistantContextValue {
  return {
    d: { allNamespaceNames: ["default"], roles: { worker: { provider: "claude", model: "claude-sonnet-4-6", effort: "high" }, supervisor: { provider: "claude", model: "claude-opus-4-8", effort: "high" } }, limits: {} },
    working: false,
    run,
    actionError: null,
    installNamespace: "default",
    setInstallNamespace: vi.fn(),
    openConfirmCreateNs: (doInstall: () => void) => doInstall(),
  } as unknown as AssistantContextValue;
}

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssistantContext value={ctx()}>
        <InstallView />
      </AssistantContext>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  run.mockReset();
  agentToken.mockClear();
  agentToken.mockResolvedValue({ token: "rig_agent_tok", installId: "inst-1" });
  mockOrgs = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/chat-config")) return new Response(JSON.stringify({ configured: false, source: null }));
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

describe("InstallView (multi-provider)", () => {
  it("renders the role pickers defaulting to Claude worker/supervisor", async () => {
    wrap();
    expect(screen.getByText("Worker")).toBeInTheDocument();
    expect(screen.getByText("Supervisor")).toBeInTheDocument();
    expect(await screen.findAllByText("claude-sonnet-4-6")).toBeTruthy();
  });

  it("installs with worker/supervisor selections + a pasted token folded into credentials", async () => {
    wrap();
    await screen.findAllByText("claude-sonnet-4-6");
    await userEvent.type(screen.getByPlaceholderText(/CLAUDE_CODE_OAUTH_TOKEN/i), "tok-abc");
    await userEvent.click(screen.getByRole("button", { name: /^install$/i }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "install",
        worker: expect.objectContaining({ provider: "claude", model: "claude-sonnet-4-6" }),
        supervisor: expect.objectContaining({ provider: "claude", model: "claude-opus-4-8" }),
        credentials: expect.objectContaining({ claudeToken: "tok-abc" }),
      }),
      expect.any(Function),
    );
  });

  it("mints an install-scoped agent token for the personal org and threads it into credentials", async () => {
    mockOrgs = [{ id: "org-personal", kind: "personal", name: "Me", role: "owner" }];
    wrap();
    await screen.findAllByText("claude-sonnet-4-6");
    await userEvent.type(screen.getByPlaceholderText(/CLAUDE_CODE_OAUTH_TOKEN/i), "tok-abc");
    await userEvent.click(screen.getByRole("button", { name: /^install$/i }));
    expect(agentToken).toHaveBeenCalledWith("org-personal");
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ action: "install", credentials: expect.objectContaining({ agentToken: "rig_agent_tok" }) }),
      expect.any(Function),
    );
  });

  it("installs token-less when the mint fails (offline / non-member)", async () => {
    mockOrgs = [{ id: "org-personal", kind: "personal", name: "Me", role: "owner" }];
    agentToken.mockResolvedValue(null);
    wrap();
    await screen.findAllByText("claude-sonnet-4-6");
    await userEvent.type(screen.getByPlaceholderText(/CLAUDE_CODE_OAUTH_TOKEN/i), "tok-abc");
    await userEvent.click(screen.getByRole("button", { name: /^install$/i }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].credentials.agentToken).toBeUndefined();
  });
});
