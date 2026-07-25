// @vitest-environment jsdom
//
// The wizard is the single first-run surface: Cluster → AI agent → Email. The AI
// step connects an agent through the REAL Agents flow (AgentsTab: grid →
// per-agent auth), NOT a Claude-token field, and carries the two optional
// in-cluster installs. Leaving early must not mark setup complete.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentsResponse, AgentView } from "@/lib/api";
import type { UseAccountResult } from "./useAccount";

import { OnboardingWizard } from "./OnboardingWizard";

const claude: AgentView = {
  id: "claude", label: "Claude Code", vendor: "Anthropic", status: "available",
  connection: "notSignedIn", authMethods: ["subscription", "apiKey"], authMethod: "subscription",
  installUrl: "https://x", installLabel: "Install Claude Code",
};
const codex: AgentView = {
  id: "codex", label: "Codex", vendor: "OpenAI", status: "available",
  connection: "connected", authMethods: ["subscription", "apiKey"], authMethod: "subscription",
  installUrl: "https://x", installLabel: "Install Codex",
};

function fakeAccount(over: Partial<UseAccountResult> = {}): UseAccountResult {
  return {
    status: "signed-out",
    account: null,
    me: null,
    orgs: [],
    entitlement: null,
    pendingSignIn: null,
    startSignIn: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    signOut: vi.fn(),
    refresh: vi.fn(),
    upgrade: vi.fn(),
    manageBilling: vi.fn(),
    refreshBilling: vi.fn(),
    ...over,
  } as UseAccountResult;
}

function renderWizard(agents?: AgentsResponse, metricsAvailable?: boolean, account = fakeAccount()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (agents) qc.setQueryData(["agents"], agents);
  if (metricsAvailable !== undefined) {
    qc.setQueryData([null, "metrics", "nodes"], { available: metricsAvailable, items: [] });
  }
  qc.setQueryData(["contexts"], []);
  const onClose = vi.fn();
  const onLeave = vi.fn();
  const { container } = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OnboardingWizard account={account} onClose={onClose} onLeave={onLeave} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose, onLeave, account, container };
}

const next = () => fireEvent.click(screen.getByRole("button", { name: /^next →$/i }));
const done = () => fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
const currentStep = () => document.querySelector('[aria-current="step"]');
const pending = { email: "jane@acme.com", expiresAt: Date.now() + 1000, displayCode: "4K7Q-9WXZ" };

describe("OnboardingWizard AI-agent step", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("renders the real Agents picker on the AI step, not a Claude-token field", () => {
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] });
    next();

    expect(screen.getByText(/connect your ai agent/i)).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText(/credentials never leave your machine/i)).toBeInTheDocument();

    // No leftover Claude-token field.
    expect(screen.queryByPlaceholderText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
  });

  it("shows the Provider connected pill when the active agent is connected", () => {
    // Codex is active + connected → the step head shows the status pill.
    renderWizard({ activeAgentId: "codex", agents: [claude, codex] });
    next();
    expect(screen.getByText(/provider connected/i)).toBeInTheDocument();
  });

  it("does NOT show the pill when a non-active agent is the connected one", () => {
    // Claude is active but notSignedIn; codex is connected but NOT active. The
    // pill tracks the ACTIVE agent, so "any agent connected" must not light it.
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] });
    next();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.queryByText(/provider connected/i)).not.toBeInTheDocument();
  });

  it("keeps the AI step optional (Next advances past it without connecting)", () => {
    renderWizard({ activeAgentId: "claude", agents: [claude, codex] });
    next();

    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent("AI agent");

    next();
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent("Email");
  });
});

describe("OnboardingWizard steps", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("has exactly three steps: Cluster, AI agent, Email", () => {
    renderWizard();
    expect(screen.getByText("Cluster")).toBeInTheDocument();
    expect(screen.getByText("AI agent")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.queryByText("Assistant")).not.toBeInTheDocument();
    expect(screen.queryByText("Next steps")).not.toBeInTheDocument();
  });

  it("opens on the cluster step", () => {
    renderWizard();
    expect(screen.getByText("Create a local cluster")).toBeInTheDocument();
  });

  // The rail opens with progress already banked: installing the app is a step
  // the user HAS finished, so it reads Complete from the first frame and Cluster
  // becomes step two of four.
  it("shows Installed as an already-complete first step without making it current", () => {
    renderWizard();
    expect(screen.getByText("Installed").parentElement).toHaveTextContent("Complete");
    expect(currentStep()).toHaveTextContent("Cluster");
    expect(currentStep()).not.toHaveTextContent("Installed");
    expect(currentStep()).toHaveTextContent("2");
  });

  // Installed is rail chrome, not a destination: there is no body behind it, so
  // the opening step must not offer a way back to it.
  it("offers no Back from the cluster step", () => {
    renderWizard();
    expect(screen.queryByRole("button", { name: /^back$/i })).not.toBeInTheDocument();
  });

  it("walks Cluster to AI agent to Email and finishes", () => {
    const { onClose } = renderWizard();
    // Asserted on the step chrome, which renders for the CURRENT step only. The
    // bodies are all mounted (hidden), so a body query proves nothing here.
    expect(currentStep()).toHaveTextContent("Cluster");

    next();
    expect(currentStep()).toHaveTextContent("AI agent");
    expect(screen.getByText(/connect your ai agent/i)).toBeInTheDocument();

    next();
    expect(currentStep()).toHaveTextContent("Email");
    expect(screen.getByText("Sign in to Rigel")).toBeInTheDocument();

    // The last step swaps Next for Done, so there is exactly one way onward at
    // every point and never two controls doing the same thing.
    expect(screen.queryByRole("button", { name: /^next →$/i })).not.toBeInTheDocument();
    done();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("drops the Compose and notifications link farm and the upsell", () => {
    renderWizard();
    next();
    next();
    expect(screen.queryByText(/compose stack/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/set up notifications/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/free plan/i)).not.toBeInTheDocument();
  });

  it("offers the Assistant and metrics-server installs as an optional row on the AI step", () => {
    renderWizard(undefined, false);
    next();
    expect(screen.getByText("Assistant agent")).toBeInTheDocument();
    expect(screen.getByText("metrics-server")).toBeInTheDocument();
  });

  it("hides metrics-server when the cluster already has it", () => {
    renderWizard(undefined, true);
    next();
    expect(screen.getByText("Assistant agent")).toBeInTheDocument();
    expect(screen.queryByText("metrics-server")).not.toBeInTheDocument();
  });

  it("marks onboarding complete only from the last step", () => {
    const { onClose, onLeave } = renderWizard();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).not.toHaveBeenCalled();
    expect(onLeave).toHaveBeenCalledOnce();
  });
});

// The two rules that make this a hand-rolled modal rather than the Dialog
// primitive: finishing is always an explicit click, and the scrim is inert.
describe("OnboardingWizard finishing is explicit", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("finishes when Done is clicked on the last step", () => {
    // Done only exists once a sign-in is pending, so the wizard's primary is
    // never competing with SignInFlow's own "Send sign-in link" primary.
    const { onClose, onLeave } = renderWizard(undefined, undefined, fakeAccount({ pendingSignIn: pending }));
    next();
    next();
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("does not close when the scrim is clicked", () => {
    const { onClose, onLeave, container } = renderWizard();
    fireEvent.click(container.firstElementChild!);
    expect(onClose).not.toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("does NOT finish on a stray Enter on the last step", () => {
    // A stray Enter that reached onClose would set rigel_onboarded and retire
    // first-run setup for good, so the last step must ignore it entirely.
    const { onClose } = renderWizard();
    next();
    next();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("still advances on Enter from an earlier step", () => {
    renderWizard();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(currentStep()).toHaveTextContent("AI agent");
  });
});

// One primary at a time on the last step. Both candidates are on screen at once
// now that Done is unconditional, so the rule is carried by weight rather than
// presence: Done is styled secondary until SignInFlow gives up its own primary.
// The two buttons encode "primary" differently: the wizard footer is inline
// styled, SignInFlow uses the shadcn Button's default variant.
const isPrimary = (b: HTMLElement) =>
  b.style.background.includes("accent-primary") || b.classList.contains("bg-primary");

describe("OnboardingWizard last step has a single primary", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("keeps Done secondary until a sign-in is pending, leaving Send sign-in link the only primary", () => {
    renderWizard(undefined, undefined, fakeAccount({ pendingSignIn: null }));
    next();
    next();
    expect(currentStep()).toHaveTextContent("Email");

    expect(isPrimary(screen.getByRole("button", { name: /send sign-in link/i }))).toBe(true);
    expect(isPrimary(screen.getByRole("button", { name: /^done$/i }))).toBe(false);
    expect(screen.getByRole("button", { name: /^back$/i })).toBeInTheDocument();
  });

  // Done is the ONLY control that marks setup complete: the X deliberately
  // leaves it unset so onboarding can reopen. Gating Done on a sign-in would
  // strand anyone who declines to leave an email, reopening setup every launch.
  it("finishes without an email, with no sign-in started", () => {
    const { onClose, onLeave } = renderWizard(undefined, undefined, fakeAccount({ pendingSignIn: null }));
    next();
    next();
    done();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("keeps Done once the sign-in succeeded and the pending record cleared", () => {
    // A successful poll clears pendingSignIn and sets status "signed-in" in the
    // same refresh, so the gate must accept either or Done would vanish from
    // under a user who just signed in.
    const { onClose } = renderWizard(
      undefined,
      undefined,
      fakeAccount({ status: "signed-in", pendingSignIn: null }),
    );
    next();
    next();
    expect(screen.queryByRole("button", { name: /send sign-in link/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("promotes Done to primary once a sign-in is pending, when the body primary is gone", () => {
    renderWizard(undefined, undefined, fakeAccount({ pendingSignIn: pending }));
    next();
    next();

    expect(screen.getByText("Check your inbox")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send sign-in link/i })).not.toBeInTheDocument();
    expect(isPrimary(screen.getByRole("button", { name: /^done$/i }))).toBe(true);
  });
});

// Skip is gone from every step: on the earlier ones it duplicated Next exactly
// (same handler), and on the last one Done absorbed it.
describe("OnboardingWizard has no Skip control", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("offers no Skip on any step", () => {
    renderWizard();
    for (const label of ["Cluster", "AI agent", "Email"]) {
      expect(currentStep()).toHaveTextContent(label);
      expect(screen.queryByRole("button", { name: /^skip$/i })).not.toBeInTheDocument();
      if (label !== "Email") next();
    }
  });
});

describe("OnboardingWizard keeps step state across navigation", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("keeps a typed email across a Back then Next round trip", () => {
    renderWizard();
    next();
    next();
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "jane@acme.com" } });

    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next →$/i }));

    expect(screen.getByLabelText(/email address/i)).toHaveValue("jane@acme.com");
  });

  it("keeps an in-progress kubeconfig import across a Next then Back round trip", () => {
    renderWizard();
    fireEvent.click(screen.getByText("Import a kubeconfig"));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "apiVersion: v1" } });

    fireEvent.click(screen.getByRole("button", { name: /^next →$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));

    // Still inside the import flow (not dumped back to the option list), with
    // the pasted kubeconfig intact.
    expect(screen.getByText("All connection options")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("apiVersion: v1");
  });
});
