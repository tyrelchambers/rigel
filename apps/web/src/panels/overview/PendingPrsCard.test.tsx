// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PendingPrsCard } from "./PendingPrsCard";
import type { ChatPrRecord } from "@/panels/gitops/gitApi";

const state = vi.hoisted(() => ({
  prs: [] as ChatPrRecord[],
  agentPrs: [] as unknown[],
  sources: [] as unknown[],
  status: {} as Record<string, { state: string; number: number }>,
  dismissed: [] as string[],
}));

vi.mock("@/panels/assistant/useAssistant", () => ({
  useAssistant: () => ({ pullRequests: state.agentPrs }),
}));

vi.mock("@/panels/gitops/gitApi", () => ({
  useChatPullRequests: () => ({ data: state.prs }),
  useGitSources: () => ({ data: state.sources }),
  usePrStatus: (url: string) => ({ data: state.status[url] }),
  useDismissPullRequest: () => ({
    mutate: (id: string) => state.dismissed.push(id),
    isPending: false,
  }),
}));

afterEach(() => {
  cleanup();
  state.prs = [];
  state.agentPrs = [];
  state.sources = [];
  state.status = {};
  state.dismissed = [];
});

const AGENT_PR_URL = "https://github.com/o/api/pull/12";

const agentPr = () => ({
  at: "2026-07-23T00:00:00.000Z",
  fingerprint: "fp1",
  filePath: "k8s/api.yaml",
  incident: "OOMKilled",
  app: "api-web",
  repo: "https://github.com/o/api.git",
  branch: "rigel/b",
  prUrl: AGENT_PR_URL,
  title: "Raise API memory",
  summary: "ok",
  status: "open",
  kind: "config",
});

const PR_URL = "https://github.com/o/jobwatch/pull/42";

const pr = (over: Partial<ChatPrRecord> = {}): ChatPrRecord => ({
  id: "p1",
  prUrl: PR_URL,
  number: 42,
  repoSlug: "o/jobwatch",
  repoName: "jobwatch",
  source: "jobwatch-web",
  title: "Raise memory limit",
  branch: "rigel/fix",
  filePath: "k8s/deploy.yaml",
  createdAt: "2026-07-24T00:00:00.000Z",
  ...over,
});

const withSource = () => {
  state.sources = [
    {
      name: "jobwatch",
      repoURL: "https://github.com/o/jobwatch",
      branch: "main",
      deployments: [{ name: "jobwatch-web", path: "k8s" }],
    },
  ];
};

describe("PendingPrsCard", () => {
  test("renders a row per PR with its repo, number, and title", () => {
    state.prs = [pr()];
    render(<PendingPrsCard />);
    expect(screen.getByText("o/jobwatch #42")).toBeInTheDocument();
    expect(screen.getByText(/Raise memory limit/)).toBeInTheDocument();
  });

  test("shows an empty state when there are no PRs", () => {
    render(<PendingPrsCard />);
    expect(screen.getByText(/no open pull requests/i)).toBeInTheDocument();
  });

  test("offers Sync now only once the PR is merged", () => {
    withSource();
    state.prs = [pr()];
    state.status[PR_URL] = { state: "open", number: 42 };
    render(<PendingPrsCard />);
    expect(screen.queryByRole("button", { name: /sync now/i })).toBeNull();

    cleanup();
    state.status[PR_URL] = { state: "merged", number: 42 };
    render(<PendingPrsCard />);
    expect(screen.getByRole("button", { name: /sync now/i })).toBeInTheDocument();
  });

  test("disables Sync when the deployment no longer resolves", () => {
    state.prs = [pr()]; // no sources registered
    state.status[PR_URL] = { state: "merged", number: 42 };
    render(<PendingPrsCard />);
    expect(screen.getByRole("button", { name: /sync now/i })).toBeDisabled();
  });

  test("dismiss removes the PR from the ledger", () => {
    state.prs = [pr({ id: "p9" })];
    render(<PendingPrsCard />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(state.dismissed).toEqual(["p9"]);
  });

  test("lists agent-opened PRs alongside chat ones, tagged by origin", () => {
    state.prs = [pr()];
    state.agentPrs = [agentPr()];
    render(<PendingPrsCard />);
    expect(screen.getByText("o/jobwatch #42")).toBeInTheDocument();
    expect(screen.getByText("o/api #12")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });

  test("agent PRs cannot be dismissed (the agent owns that record)", () => {
    state.agentPrs = [agentPr()];
    render(<PendingPrsCard />);
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
  });

  test("offers Sync now for a merged agent PR too", () => {
    state.sources = [
      {
        name: "api",
        repoURL: "https://github.com/o/api",
        branch: "main",
        deployments: [{ name: "api-web", path: "k8s" }],
      },
    ];
    state.agentPrs = [agentPr()];
    state.status[AGENT_PR_URL] = { state: "merged", number: 12 };
    render(<PendingPrsCard />);
    expect(screen.getByRole("button", { name: /sync now/i })).toBeEnabled();
  });
});
