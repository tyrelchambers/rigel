// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentSetup } from "./AgentSetup";
import type { AgentView } from "@/lib/api";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const claude: AgentView = {
  id: "claude", label: "Claude Code", vendor: "Anthropic", status: "available",
  connection: "notSignedIn", authMethods: ["subscription", "apiKey"], authMethod: "subscription",
  installUrl: "https://x", installLabel: "Install Claude Code",
};

const keyField = () => screen.getByLabelText(/claude code api key/i) as HTMLInputElement;
const chooseApiKey = () => fireEvent.click(screen.getByRole("button", { name: /paste your anthropic api key/i }));

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

  it("shows the 'Use this agent' button for a connected, non-active agent", () => {
    wrap(<AgentSetup agent={{ ...claude, connection: "connected" }} isActive={false} onBack={() => {}} />);
    expect(screen.getByRole("button", { name: /use this agent/i })).toBeInTheDocument();
    // never the word "Active"
    expect(screen.queryByText(/active/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^In use$/)).not.toBeInTheDocument();
  });

  it("shows a non-interactive 'In use' indicator (never 'Active') when the agent is already in use", () => {
    wrap(<AgentSetup agent={{ ...claude, connection: "connected" }} isActive onBack={() => {}} />);
    expect(screen.queryByRole("button", { name: /use this agent/i })).not.toBeInTheDocument();
    expect(screen.getByText(/^In use$/)).toBeInTheDocument();
    expect(screen.queryByText(/active/i)).not.toBeInTheDocument();
  });

  it("renders neither the in-use indicator nor the button for a not-connected agent", () => {
    wrap(<AgentSetup agent={{ ...claude, connection: "notSignedIn" }} onBack={() => {}} />);
    expect(screen.queryByRole("button", { name: /use this agent/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^In use$/)).not.toBeInTheDocument();
  });

  it("shows asterisks for a stored key, so a saved key does not look unset", () => {
    wrap(<AgentSetup agent={{ ...claude, authMethod: "apiKey", apiKeySet: true }} onBack={() => {}} />);
    chooseApiKey();
    expect(keyField().placeholder).toMatch(/^\*+$/);
    expect(keyField().value).toBe("");
    expect(screen.getByText(/type a new one to replace it/i)).toBeInTheDocument();
  });

  it("without a stored key the field says what to paste", () => {
    wrap(<AgentSetup agent={{ ...claude, authMethod: "apiKey" }} onBack={() => {}} />);
    chooseApiKey();
    expect(keyField().placeholder).toBe("sk-ant-…");
    expect(screen.queryByText(/type a new one to replace it/i)).not.toBeInTheDocument();
  });

  it("an untouched stored key cannot be saved over: Save waits for a typed replacement", () => {
    wrap(<AgentSetup agent={{ ...claude, authMethod: "apiKey", apiKeySet: true }} onBack={() => {}} />);
    chooseApiKey();
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
    fireEvent.change(keyField(), { target: { value: "sk-ant-new" } });
    expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
  });

  it("with no cluster to save to, the key field and Save are locked", () => {
    wrap(<AgentSetup agent={{ ...claude, authMethod: "apiKey" }} locked onBack={() => {}} />);
    expect(keyField()).toBeDisabled();
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("guides the steps by status: not installed shows the install prompt", () => {
    wrap(<AgentSetup agent={{ ...claude, connection: "notInstalled" }} onBack={() => {}} />);
    expect(screen.getByText(/isn't installed on this machine yet/i)).toBeInTheDocument();
    expect(screen.getByText("Not installed")).toBeInTheDocument();
  });

  it("guides the steps by status: installed-but-unauthenticated shows 'Not signed in'", () => {
    wrap(<AgentSetup agent={{ ...claude, connection: "notSignedIn" }} onBack={() => {}} />);
    expect(screen.getByText(/CLI was found on this machine/i)).toBeInTheDocument();
    expect(screen.getByText("Not signed in")).toBeInTheDocument();
  });
});
