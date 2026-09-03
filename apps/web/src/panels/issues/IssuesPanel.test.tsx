// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { rollUpIssues } from "@rigel/k8s/src/issues/engine";
import { issueFingerprint, type Issue } from "@rigel/k8s/src/issues/types";
import IssuesPanel from "./IssuesPanel";

const mute = vi.fn();
const unmute = vi.fn();

let live: Issue[] = [];
let muted: Issue[] = [];

vi.mock("./useIssues", async () => {
  const actual = await vi.importActual<typeof import("./useIssues")>("./useIssues");
  return {
    ...actual,
    useIssues: () => ({
      issues: live,
      muted,
      groups: rollUpIssues(live),
      loading: false,
      updatedAt: new Date(),
    }),
  };
});

vi.mock("./useIssueMutes", () => ({
  useIssueMutes: () => ({ mutes: {}, mute, unmute, saving: false }),
}));

function issue(over: Partial<Issue> = {}): Issue {
  const base: Issue = {
    fingerprint: "",
    rule: "crashLoopBackOff",
    title: "CrashLoopBackOff",
    category: "runtime",
    severity: "critical",
    subject: { kind: "Pod", namespace: "default", name: "api-0" },
    cause: "Back-off restarting failed container",
    whatsWrong: "The container keeps crashing.",
    nextStep: "Read the container logs.",
    related: [],
    source: "cluster",
    ...over,
  };
  return { ...base, fingerprint: issueFingerprint(base) };
}

const warning = issue({
  rule: "pvcUnbound",
  title: "PVC unbound",
  category: "storage",
  severity: "warning",
  subject: { kind: "PersistentVolumeClaim", namespace: "media", name: "paperless-data" },
  cause: "No matching PersistentVolume",
});

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <IssuesPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("IssuesPanel", () => {
  beforeEach(() => {
    live = [issue(), warning];
    muted = [];
    vi.clearAllMocks();
  });

  it("renders a row per group and counts the unmuted issues", () => {
    renderPanel();
    expect(screen.getByText("CrashLoopBackOff")).toBeInTheDocument();
    expect(screen.getByText("PVC unbound")).toBeInTheDocument();
    expect(screen.getByText("Issues")).toBeInTheDocument();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
  });

  it("filters the list by search", async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText("Search issues"), "paperless");
    expect(screen.queryByText("CrashLoopBackOff")).not.toBeInTheDocument();
    expect(screen.getByText("PVC unbound")).toBeInTheDocument();
  });

  it("hides critical rows when the Warning chip is selected", async () => {
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: /Warning/ }));
    expect(screen.queryByText("CrashLoopBackOff")).not.toBeInTheDocument();
    expect(screen.getByText("PVC unbound")).toBeInTheDocument();
  });

  it("shows the empty state when nothing is detected", () => {
    live = [];
    renderPanel();
    expect(screen.getByText("No issues right now")).toBeInTheDocument();
  });

  it("shows a distinct empty state when the filters hide everything", async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText("Search issues"), "nothing-matches-this");
    expect(screen.getByText("No matching issues")).toBeInTheDocument();
  });

  it("keeps muted issues out of the list and inside the Muted section", async () => {
    muted = [issue({ subject: { kind: "Pod", namespace: "staging", name: "legacy-0" } })];
    renderPanel();
    expect(screen.queryByText("staging / legacy-0")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Muted/ }));
    expect(screen.getByText("staging / legacy-0")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(unmute).toHaveBeenCalledWith(muted[0].fingerprint);
  });
});
