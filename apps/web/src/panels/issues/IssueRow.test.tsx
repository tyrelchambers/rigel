// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { IssueRow, MutedIssueRow } from "./IssueRow";
import { issueFingerprint, type Issue, type IssueGroup } from "@rigel/k8s/src/issues/types";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api");
  return { ...actual, apiFetch: vi.fn(async () => new Response("{}")) };
});

function issue(name: string, over: Partial<Issue> = {}): Issue {
  const base: Issue = {
    fingerprint: "",
    rule: "webhookBackendMissing",
    title: "Webhook backend down",
    category: "controlPlane",
    severity: "critical",
    subject: { kind: "ValidatingWebhookConfiguration", namespace: "kube-system", name },
    cause: "Missing webhook backend Service",
    whatsWrong: "The webhook backend Service does not exist, so admission requests fail.",
    nextStep: "Recreate the backend Service or remove the webhook configuration.",
    evidence: 'clientConfig.service "metallb-webhook-service" not found',
    related: [],
    source: "cluster",
    ...over,
  };
  return { ...base, fingerprint: issueFingerprint(base) };
}

function group(members: Issue[]): IssueGroup {
  return { key: `${members[0].rule}|${members[0].cause}`, lead: members[0], members };
}

function renderRow(g: IssueGroup, isOpen = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <IssueRow group={g} isOpen={isOpen} onToggle={() => {}} onMute={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("IssueRow", () => {
  it("shows the title and the subject when collapsed", () => {
    renderRow(group([issue("a")]));
    expect(screen.getByText("Webhook backend down")).toBeInTheDocument();
    expect(screen.getByText(/kube-system \/ a/)).toBeInTheDocument();
  });

  it("shows an affected count instead of a single subject for a rolled-up group", () => {
    renderRow(group([issue("a"), issue("b"), issue("c")]));
    expect(screen.getByText("3 affected")).toBeInTheDocument();
  });

  it("codes severity by shape as well as colour", () => {
    renderRow(group([issue("a", { severity: "info" })]));
    expect(screen.getByLabelText("Info")).toBeInTheDocument();
  });

  it("renders the explanation sections when expanded", () => {
    renderRow(group([issue("a")]), true);
    expect(screen.getByText(/admission requests fail/)).toBeInTheDocument();
    expect(screen.getByText(/Recreate the backend Service/)).toBeInTheDocument();
    expect(screen.getByText(/metallb-webhook-service/)).toBeInTheDocument();
  });

  it("omits the evidence section when there is no evidence", () => {
    renderRow(group([issue("a", { evidence: undefined })]), true);
    expect(screen.queryByText(/EVIDENCE/i)).not.toBeInTheDocument();
  });

  it("lists every member under AFFECTED for a rolled-up group", () => {
    renderRow(group([issue("a"), issue("b")]), true);
    expect(screen.getByText("AFFECTED")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Open" })).toHaveLength(3);
  });

  it("offers a Fix action only when the issue carries one", () => {
    renderRow(group([issue("a")]), true);
    expect(screen.queryByRole("button", { name: /restart rollout/i })).not.toBeInTheDocument();

    renderRow(
      group([
        issue("b", { fix: { label: "Restart rollout", destructive: false, command: ["rollout", "restart"] } }),
      ]),
      true,
    );
    expect(screen.getByRole("button", { name: /restart rollout/i })).toBeInTheDocument();
  });

  it("does not offer Fix in Git for a fix with no manifest form", () => {
    renderRow(
      group([
        issue("b", { fix: { label: "Restart rollout", destructive: false, command: ["rollout", "restart"] } }),
      ]),
      true,
    );
    expect(screen.queryByRole("button", { name: "Fix in Git" })).not.toBeInTheDocument();
  });
});

describe("MutedIssueRow", () => {
  it("swaps Diagnose for Unmute", () => {
    render(<MutedIssueRow issue={issue("a")} onUnmute={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Unmute" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Diagnose" })).not.toBeInTheDocument();
  });
});
