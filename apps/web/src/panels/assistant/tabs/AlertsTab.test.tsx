// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AlertsTab } from "./AlertsTab";
import { AssistantContext, type AssistantContextValue } from "../AssistantContext";
import type { AssistantDerived } from "../useAssistant";
import type { AlertRule } from "@rigel/k8s";

vi.mock("@/lib/chatHandoff", () => ({ handoffToChat: vi.fn() }));
import { handoffToChat } from "@/lib/chatHandoff";

vi.mock("@/shell/useEntitlement", () => ({ useEntitlement: vi.fn() }));
import { useEntitlement } from "@/shell/useEntitlement";
import type { EntitlementPayload } from "@/lib/desktop";

vi.mock("@/shell/useAccount", () => ({ useAccount: vi.fn() }));
import { useAccount } from "@/shell/useAccount";

vi.mock("@/shell/UpgradeContext", () => ({ useUpgrade: vi.fn() }));
import { useUpgrade } from "@/shell/UpgradeContext";

const run = vi.fn();
const setTab = vi.fn();
const upgrade = vi.fn();
const openUpgrade = vi.fn();

const entPayload = (agentAutonomy: boolean): EntitlementPayload => ({
  plan: agentAutonomy ? "pro" : "free", audits: [], cloudConnect: false, agentAutonomy, fetchedAt: "t",
});

function derived(overrides: Partial<AssistantDerived> = {}): AssistantDerived {
  return {
    autonomyMode: "auto",
    quietWindow: "",
    webhookURL: "",
    alertRules: [],
    alertLastFiredAt: {},
    silenced: [],
    allNamespaceNames: ["default"],
    allNodes: [],
    ...overrides,
  } as AssistantDerived;
}

const oomRule: AlertRule = {
  id: "r1",
  enabled: true,
  text: "Alert when any pod is OOMKilled",
  target: { scope: "cluster" },
  condition: { type: "oomKilled" },
  cooldownMinutes: 5,
  createdAt: "",
};

function ctx(d: AssistantDerived): AssistantContextValue {
  return { d, ns: "default", working: false, run, setTab } as unknown as AssistantContextValue;
}

function wrap(d = derived()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssistantContext value={ctx(d)}>
        <AlertsTab />
      </AssistantContext>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  run.mockReset();
  setTab.mockReset();
  upgrade.mockReset();
  openUpgrade.mockReset();
  vi.mocked(handoffToChat).mockReset();
  // Default: autonomy unlocked (Pro) so existing mode tests are unaffected.
  vi.mocked(useEntitlement).mockReturnValue({ payload: entPayload(true), upgrade });
  vi.mocked(useUpgrade).mockReturnValue({ openUpgrade });
  vi.mocked(useAccount).mockReturnValue({
    orgs: [{ id: "org-personal", kind: "personal", name: "Me", role: "owner" }],
  } as never);
});

describe("AlertsTab", () => {
  it("renders the Alerts empty state (with Try chips) and the Autonomy card", () => {
    wrap();
    expect(screen.getByText("Alerts")).toBeInTheDocument();
    expect(screen.getByText("No alerts yet")).toBeInTheDocument();
    expect(screen.getByText("Autonomy")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pod restarts/i })).toBeInTheDocument();
  });

  it("hands a Try suggestion to a fresh chat thread (covers non-structural conditions)", async () => {
    wrap();
    await userEvent.click(screen.getByRole("button", { name: /Node memory > 90%/i }));
    expect(handoffToChat).toHaveBeenCalledWith(expect.stringContaining("memory"), { newThread: true });
  });

  it("locks the autonomous modes and offers Upgrade when agentAutonomy is false", async () => {
    vi.mocked(useEntitlement).mockReturnValue({ payload: entPayload(false), upgrade });
    wrap();
    // "Auto" and "Quiet-hours" cards are disabled; "Advisory" stays enabled.
    expect(screen.getByRole("button", { name: /^Auto/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Quiet-hours/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Advisory/i })).toBeEnabled();
    expect(screen.getByText(/unlock the in-cluster agent/i)).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /upgrade to pro/i });
    await userEvent.click(btn);
    expect(openUpgrade).toHaveBeenCalled();
  });

  it("selecting a mode saves it via setMode", async () => {
    wrap();
    await userEvent.click(screen.getByRole("button", { name: /Advisory/i }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ action: "setMode", namespace: "default", mode: "advisory" }),
    );
  });

  it("shows the quiet-window editor only in Quiet-hours mode", () => {
    const { rerender } = wrap(derived({ autonomyMode: "auto" }));
    expect(screen.queryByText("Quiet window")).not.toBeInTheDocument();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <AssistantContext value={ctx(derived({ autonomyMode: "window", quietWindow: "22:00-07:00" }))}>
          <AlertsTab />
        </AssistantContext>
      </QueryClientProvider>,
    );
    expect(screen.getByText("Quiet window")).toBeInTheDocument();
  });

  it("Cancel reverts an edited quiet window and is disabled when unchanged", async () => {
    wrap(derived({ autonomyMode: "window", quietWindow: "22:00-07:00" }));
    const input = screen.getByDisplayValue("22:00-07:00");
    const cancel = screen.getByRole("button", { name: /^cancel$/i });
    expect(cancel).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "23:00-06:00");
    expect(cancel).toBeEnabled();
    await userEvent.click(cancel);
    expect(screen.getByDisplayValue("22:00-07:00")).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it("links to the Settings tab for notification setup", async () => {
    wrap();
    await userEvent.click(screen.getByRole("button", { name: /Settings tab/i }));
    expect(setTab).toHaveBeenCalledWith("settings");
  });

  it("renders an improved alert row: condition badge, scope chip, channel, last-fired", () => {
    wrap(
      derived({
        alertRules: [oomRule],
        alertLastFiredAt: { r1: new Date(Date.now() - 3 * 3600_000).toISOString() },
        webhookURL: "https://hooks.example/x",
      }),
    );
    expect(screen.getByText(oomRule.text)).toBeInTheDocument();
    expect(screen.getByText("OOMKilled")).toBeInTheDocument();
    expect(screen.getByText("cluster-wide")).toBeInTheDocument();
    expect(screen.getByText("Webhook")).toBeInTheDocument();
    expect(screen.getByText(/ago$/)).toBeInTheDocument();
  });

  it("shows 'never' when a rule has not fired, and no channel chip without a webhook", () => {
    wrap(derived({ alertRules: [oomRule] }));
    expect(screen.getByText("never")).toBeInTheDocument();
    expect(screen.queryByText("Webhook")).not.toBeInTheDocument();
  });

  it("toggling the row switch calls toggleAlert with the inverted enabled state", async () => {
    wrap(derived({ alertRules: [oomRule] }));
    await userEvent.click(screen.getByRole("switch", { name: /Disable alert/i }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ action: "toggleAlert", alertId: "r1", alertEnabled: false }),
    );
  });

  it("the trash button deletes the rule", async () => {
    wrap(derived({ alertRules: [oomRule] }));
    await userEvent.click(screen.getByRole("button", { name: /Delete alert/i }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ action: "deleteAlert", alertId: "r1" }),
    );
  });

  it("editing a rule opens the dialog in edit mode (Edit alert / Save changes)", async () => {
    wrap(derived({ alertRules: [oomRule] }));
    await userEvent.click(screen.getByRole("button", { name: /Edit alert/i }));
    expect(screen.getByRole("button", { name: /Save changes/i })).toBeInTheDocument();
    // Header reflects edit mode (distinct from the row's aria-label button).
    expect(screen.getByText("Edit alert")).toBeInTheDocument();
  });
});
