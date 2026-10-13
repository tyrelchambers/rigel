// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { AssistantQueuedSuggestion } from "@rigel/k8s";
import { NeedsYouTab } from "./NeedsYouTab";

const run = vi.fn();
const runSuggestion = vi.fn();
let queue: AssistantQueuedSuggestion[] = [];

vi.mock("../AssistantContext", () => ({
  useAssistantCtx: () => ({
    d: { clusterState: { queue }, liveIssues: [] },
    ns: "rigel",
    working: false,
    run,
    runSuggestion,
  }),
}));

const FIX: AssistantQueuedSuggestion = {
  at: "2026-10-11T00:00:00.000Z",
  incident: "default/memos-abc: CrashLoopBackOff",
  suggestion: "Open fix PR",
  reason: "fix PR, set to Ask me in Action levels",
  fingerprint: "unhealthyPod|default|memos-abc|CrashLoopBackOff",
  action: {
    kind: "openFixPR",
    label: "Open fix PR",
    source: "memos",
    filePath: "apps/memos/deployment.yaml",
    title: "Bump memos image to a healthy tag",
    body: "The pinned tag CrashLoops.",
  },
};

const RESTART: AssistantQueuedSuggestion = {
  at: "2026-10-11T00:00:00.000Z",
  incident: "default/api: CrashLoopBackOff",
  suggestion: "Restart api",
  reason: "set to Ask me in Action levels",
  action: { kind: "restart", label: "Restart api", name: "api", namespace: "default" },
};

function renderTab() {
  return render(
    <MemoryRouter>
      <NeedsYouTab />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  run.mockReset();
  runSuggestion.mockReset();
});

describe("NeedsYouTab", () => {
  it("a queued fix PR opens a confirmation with its title, file and body, and approves it", () => {
    queue = [FIX];
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Open fix PR" }));

    expect(screen.getByText("Bump memos image to a healthy tag")).toBeInTheDocument();
    expect(screen.getByText("apps/memos/deployment.yaml")).toBeInTheDocument();
    expect(screen.getByText("The pinned tag CrashLoops.")).toBeInTheDocument();
    expect(runSuggestion).not.toHaveBeenCalled();

    const buttons = screen.getAllByRole("button", { name: /open fix pr/i });
    const confirm = buttons[buttons.length - 1]!;
    expect(confirm.className).not.toMatch(/bg-destructive/);
    fireEvent.click(confirm);
    expect(run).toHaveBeenCalledWith({
      action: "approveQueuedFix",
      namespace: "rigel",
      queuedId: `${FIX.at}|${FIX.incident}|${FIX.suggestion}`,
      fingerprint: FIX.fingerprint,
    });
  });

  it("a fix PR already being opened shows a muted label instead of an approve button", () => {
    queue = [{ ...FIX, reason: "fix PR pending the fix-runner", pending: true }];
    renderTab();
    expect(screen.queryByRole("button", { name: "Open fix PR" })).not.toBeInTheDocument();
    expect(screen.getByText("Opening PR…")).toBeInTheDocument();
  });

  it("a queued kubectl action still goes to the confirm sheet", () => {
    queue = [RESTART];
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Restart api" }));
    expect(runSuggestion).toHaveBeenCalledWith(RESTART.action);
    expect(run).not.toHaveBeenCalled();
  });
});
