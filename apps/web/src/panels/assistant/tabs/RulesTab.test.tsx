// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RulesTab } from "./RulesTab";
import { AssistantContext, type AssistantContextValue } from "../AssistantContext";
import type { AssistantDerived } from "../useAssistant";

vi.mock("@/lib/chatHandoff", () => ({ handoffToChat: vi.fn() }));
import { handoffToChat } from "@/lib/chatHandoff";

const run = vi.fn();
const setTab = vi.fn();

function derived(overrides: Partial<AssistantDerived> = {}): AssistantDerived {
  return {
    autonomyMode: "auto",
    quietWindow: "",
    webhookURL: "",
    alertRules: [],
    silenced: [],
    allNamespaceNames: ["default"],
    ...overrides,
  } as AssistantDerived;
}

function ctx(d: AssistantDerived): AssistantContextValue {
  return { d, ns: "default", working: false, run, setTab } as unknown as AssistantContextValue;
}

function wrap(d = derived()) {
  return render(
    <AssistantContext value={ctx(d)}>
      <RulesTab />
    </AssistantContext>,
  );
}

beforeEach(() => {
  run.mockReset();
  setTab.mockReset();
  vi.mocked(handoffToChat).mockReset();
});

describe("RulesTab", () => {
  it("renders the Alerts empty state (with Try chips) and the Autonomy card", () => {
    wrap();
    expect(screen.getByText("Alerts")).toBeInTheDocument();
    expect(screen.getByText("No alerts yet")).toBeInTheDocument();
    expect(screen.getByText("Autonomy & notifications")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pod restarts/i })).toBeInTheDocument();
  });

  it("hands a Try suggestion to a fresh chat thread (covers non-structural conditions)", async () => {
    wrap();
    await userEvent.click(screen.getByRole("button", { name: /Node memory > 90%/i }));
    expect(handoffToChat).toHaveBeenCalledWith(expect.stringContaining("memory"), { newThread: true });
  });

  it("selecting a mode saves it via setMode", async () => {
    wrap();
    await userEvent.click(screen.getByRole("button", { name: /Advisory/i }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ action: "setMode", namespace: "default", mode: "advisory" }),
    );
  });

  it("saving the webhook persists the URL via setMode alongside the current mode", async () => {
    wrap(derived({ autonomyMode: "advisory" }));
    await userEvent.type(
      screen.getByPlaceholderText(/Paste webhook URL/i),
      "https://hooks.example/x",
    );
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "setMode",
        namespace: "default",
        mode: "advisory",
        webhook: "https://hooks.example/x",
      }),
    );
  });

  it("shows the quiet-window editor only in Quiet-hours mode", () => {
    const { rerender } = wrap(derived({ autonomyMode: "auto" }));
    expect(screen.queryByText("Quiet window")).not.toBeInTheDocument();
    rerender(
      <AssistantContext value={ctx(derived({ autonomyMode: "window", quietWindow: "22:00-07:00" }))}>
        <RulesTab />
      </AssistantContext>,
    );
    expect(screen.getByText("Quiet window")).toBeInTheDocument();
  });

  it("links to the Settings tab for Signal setup", async () => {
    wrap();
    await userEvent.click(screen.getByRole("button", { name: /Settings tab/i }));
    expect(setTab).toHaveBeenCalledWith("settings");
  });
});
