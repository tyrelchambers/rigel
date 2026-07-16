// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OverviewTab } from "./OverviewTab";
import { AssistantContext, type AssistantContextValue } from "../AssistantContext";
import type { AssistantDerived } from "../useAssistant";

// The owned-resources grid pulls in the router + cluster store + WS; the paused
// card under test is independent of it, so stub it out.
vi.mock("../OwnedResources", () => ({ OwnedResources: () => null }));

vi.mock("@/shell/useEntitlement", () => ({ useEntitlement: vi.fn() }));
import { useEntitlement } from "@/shell/useEntitlement";
import type { EntitlementPayload } from "@/lib/desktop";

vi.mock("@/shell/useAccount", () => ({ useAccount: vi.fn() }));
import { useAccount } from "@/shell/useAccount";

const run = vi.fn();
const setTab = vi.fn();
const upgrade = vi.fn();

const entPayload = (agentAutonomy: boolean): EntitlementPayload => ({
  plan: agentAutonomy ? "pro" : "free", audits: [], cloudConnect: false, agentAutonomy, fetchedAt: "t",
});

function derived(overrides: Partial<AssistantDerived> = {}): AssistantDerived {
  return {
    isInstalled: true,
    agentDesiredReplicas: 1,
    pullRequests: [],
    clusterState: null,
    ...overrides,
  } as AssistantDerived;
}

function ctx(d: AssistantDerived): AssistantContextValue {
  return { d, ns: "default", working: false, run, setTab } as unknown as AssistantContextValue;
}

function wrap(d = derived()) {
  return render(
    <AssistantContext value={ctx(d)}>
      <OverviewTab />
    </AssistantContext>,
  );
}

beforeEach(() => {
  run.mockReset();
  setTab.mockReset();
  upgrade.mockReset();
  vi.mocked(useEntitlement).mockReturnValue({ payload: entPayload(true), upgrade });
  vi.mocked(useAccount).mockReturnValue({
    orgs: [{ id: "org-personal", kind: "personal", name: "Me", role: "owner" }],
  } as never);
});

describe("OverviewTab — paused agent affordance", () => {
  it("renders neither Resume nor upgrade CTA when the agent is running (replicas ≥ 1)", () => {
    wrap(derived({ agentDesiredReplicas: 1 }));
    expect(screen.queryByRole("button", { name: /resume agent/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Agent paused")).not.toBeInTheDocument();
  });

  it("shows a Resume button that scales the agent back up when entitled and scaled to zero", async () => {
    wrap(derived({ agentDesiredReplicas: 0 }));
    expect(screen.getByText("Agent paused")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /resume agent/i }));
    expect(run).toHaveBeenCalledWith({ action: "resume", namespace: "default" });
  });

  it("shows the upgrade CTA (not Resume) when scaled to zero and not entitled", async () => {
    vi.mocked(useEntitlement).mockReturnValue({ payload: entPayload(false), upgrade });
    wrap(derived({ agentDesiredReplicas: 0 }));
    expect(screen.queryByRole("button", { name: /resume agent/i })).not.toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /upgrade to pro/i });
    await userEvent.click(btn);
    expect(upgrade).toHaveBeenCalledWith("org-personal");
    expect(run).not.toHaveBeenCalled();
  });
});
