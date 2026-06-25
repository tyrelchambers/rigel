// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CredentialSourceDialog } from "./CredentialSourceDialog";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// listCredentialSecrets returns names + key NAMES only (never values).
const SECRETS = [
  { name: "my-anthropic-secret", type: "Opaque", keys: ["api-key", "extra"] },
  { name: "team-keys", type: "Opaque", keys: ["claude", "openai"] },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/assistant")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as { action?: string };
        if (body.action === "listCredentialSecrets") {
          return new Response(JSON.stringify({ success: true, stdout: JSON.stringify({ secrets: SECRETS }), stderr: "" }));
        }
        return new Response(JSON.stringify({ success: true, stdout: "", stderr: "" }));
      }
      return new Response(JSON.stringify({ models: [], efforts: [] }));
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function defaults() {
  return {
    id: "claude" as const,
    label: "Claude",
    namespace: "default",
    open: true,
    onOpenChange: vi.fn(),
    onSaveKey: vi.fn(),
    onSaveSource: vi.fn(),
    onUseManaged: vi.fn(),
  };
}

describe("CredentialSourceDialog", () => {
  it("opens in managed mode showing the paste-a-key editor", async () => {
    wrap(<CredentialSourceDialog {...defaults()} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Claude credential source/i)).toBeInTheDocument();
    // Managed mode renders the paste editor (a credential value input).
    expect(within(dialog).getByLabelText(/credential value/i)).toBeInTheDocument();
  });

  it("in existing-Secret mode lists Secrets, picking one populates the key dropdown", async () => {
    wrap(<CredentialSourceDialog {...defaults()} />);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("tab", { name: /existing secret/i }));

    // Open the Secret picker and choose one.
    await userEvent.click(within(dialog).getByRole("button", { name: /^secret$/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "my-anthropic-secret" }));

    // The key picker now offers that Secret's keys (names only).
    await userEvent.click(within(dialog).getByRole("button", { name: /^key$/i }));
    expect(await screen.findByRole("menuitem", { name: "api-key" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "extra" })).toBeInTheDocument();
  });

  it("confirming an existing Secret calls onSaveSource with { credentialId, secretName, dataKey }", async () => {
    const props = defaults();
    wrap(<CredentialSourceDialog {...props} />);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("tab", { name: /existing secret/i }));

    await userEvent.click(within(dialog).getByRole("button", { name: /^secret$/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "my-anthropic-secret" }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^key$/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "api-key" }));

    await userEvent.click(within(dialog).getByRole("button", { name: /save & restart/i }));
    expect(props.onSaveSource).toHaveBeenCalledWith({
      credentialId: "claudeToken",
      secretName: "my-anthropic-secret",
      dataKey: "api-key",
    });
  });

  it("shows the ENV → secret · key readout in existing-Secret mode (names only)", async () => {
    wrap(<CredentialSourceDialog {...defaults()} />);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("tab", { name: /existing secret/i }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^secret$/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "my-anthropic-secret" }));
    await userEvent.click(within(dialog).getByRole("button", { name: /^key$/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "api-key" }));
    expect(
      within(dialog).getByText(/read CLAUDE_CODE_OAUTH_TOKEN from my-anthropic-secret/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Values never leave the cluster/i)).toBeInTheDocument();
  });

  it("managed-mode save routes the pasted key value to onSaveKey", async () => {
    const props = defaults();
    wrap(<CredentialSourceDialog {...props} />);
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/credential value/i), "tok-1");
    await userEvent.click(within(dialog).getByRole("button", { name: /save & restart/i }));
    // Claude defaults to the subscription method → claudeToken.
    expect(props.onSaveKey).toHaveBeenCalledWith("claudeToken", "tok-1");
  });
});
