// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AutoFixTab } from "./AutoFixTab";
import { AssistantContext, type AssistantContextValue } from "../AssistantContext";
import type { AssistantDerived, AutofixView } from "../useAssistant";
import type { AssistantPullRequest } from "@rigel/k8s";
import { useCluster } from "@/store/cluster";

const setAutofixBodies: Array<Record<string, unknown>> = [];
const lastSetAutofix = () => setAutofixBodies[setAutofixBodies.length - 1];

const linkBodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  setAutofixBodies.length = 0;
  linkBodies.length = 0;
  useCluster.setState({
    resources: {
      namespaces: {
        default: { metadata: { name: "default" } },
        "rigel-signups": { metadata: { name: "rigel-signups" } },
      },
      // The cluster-wide deployments watch (useAssistant's `(deployments, "*")`)
      // populates this map across namespaces — the source the Add-project search
      // reads. Two namespaces, so search/scoping crosses namespace boundaries.
      deployments: {
        "default/api": { metadata: { name: "api", namespace: "default" } },
        "default/canada-hires": { metadata: { name: "canada-hires", namespace: "default" } },
        "rigel-signups/web": { metadata: { name: "web", namespace: "rigel-signups" } },
      },
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/assistant")) {
        const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
        if (body.action === "setAutofix") setAutofixBodies.push(body);
        return new Response(JSON.stringify({ success: true, stdout: "", stderr: "" }));
      }
      if (url.includes("/api/git/link")) {
        if (init?.method === "POST") {
          // The link mutation (LinkRepoModal submit).
          linkBodies.push(JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>);
          return new Response(
            JSON.stringify({
              ok: true,
              source: "default-api",
              repo: "tyrel/api",
              repoName: "api",
              repoURL: "https://github.com/tyrel/api",
              branch: "main",
              path: "",
            }),
          );
        }
        // GET link status: canada-hires is linked; everything else is not.
        const linked = url.includes("deployment=canada-hires");
        return new Response(
          JSON.stringify({
            linked,
            link: linked
              ? {
                  source: "canada-hires",
                  repoURL: "https://github.com/tyrel/canada-hires",
                  repo: "tyrel/canada-hires",
                  branch: "main",
                  path: "",
                }
              : null,
          }),
        );
      }
      return new Response("{}");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function autofix(overrides: Partial<AutofixView> = {}): AutofixView {
  return { enabled: false, maxPerDay: 5, scope: { projects: [] }, ...overrides };
}

function derived(overrides: Partial<AssistantDerived> = {}): AssistantDerived {
  return {
    autofix: autofix(),
    pullRequests: [],
    ...overrides,
  } as AssistantDerived;
}

function wrap(d = derived()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssistantContext value={{ d, ns: "default" } as unknown as AssistantContextValue}>
        <AutoFixTab />
      </AssistantContext>
    </QueryClientProvider>,
  );
}

describe("AutoFixTab — opt-in", () => {
  it("toggling On posts setAutofix with autofixEnabled true", async () => {
    wrap(derived({ autofix: autofix({ enabled: false }) }));
    await userEvent.click(screen.getByRole("button", { name: "On" }));
    expect(lastSetAutofix()).toMatchObject({ action: "setAutofix", autofixEnabled: true });
  });

  it("editing the daily cap commits autofixMaxPerDay on blur", async () => {
    wrap(derived({ autofix: autofix({ maxPerDay: 5 }) }));
    const input = screen.getByLabelText(/max prs per day/i);
    await userEvent.clear(input);
    await userEvent.type(input, "3");
    await userEvent.tab();
    expect(lastSetAutofix()).toMatchObject({ action: "setAutofix", autofixMaxPerDay: 3 });
  });
});

describe("AutoFixTab — scope (project-only)", () => {
  it("renders project rows only — no namespace row", async () => {
    wrap(
      derived({
        autofix: autofix({ scope: { projects: ["rigel-signups/web", "default/canada-hires"] } }),
      }),
    );
    expect(screen.getByText("web")).toBeInTheDocument();
    expect(screen.getByText("canada-hires")).toBeInTheDocument();
    // No namespace-level row / copy survives the project-only redesign.
    expect(screen.queryByText(/all linked projects/i)).not.toBeInTheDocument();
    // web is not linked → shows the Link to repo pill.
    expect(await screen.findByRole("button", { name: /link to repo/i })).toBeInTheDocument();
  });

  it("shows the resolved repo for a linked project", async () => {
    wrap(derived({ autofix: autofix({ scope: { projects: ["default/canada-hires"] } }) }));
    expect(await screen.findByText("tyrel/canada-hires")).toBeInTheDocument();
  });

  it("removing a project posts setAutofix with it dropped", async () => {
    wrap(
      derived({
        autofix: autofix({ scope: { projects: ["default/canada-hires", "rigel-signups/web"] } }),
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: /remove canada-hires/i }));
    expect(lastSetAutofix()).toMatchObject({
      action: "setAutofix",
      autofixScope: { projects: ["rigel-signups/web"] },
    });
  });

  it("opens the Link to repo modal from an unlinked project", async () => {
    wrap(derived({ autofix: autofix({ scope: { projects: ["rigel-signups/web"] } }) }));
    await userEvent.click(await screen.findByRole("button", { name: /link to repo/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/web · creates a GitOps source/i)).toBeInTheDocument();
  });
});

describe("AutoFixTab — add project (deployment search)", () => {
  it("lists deployments across namespaces and filters by the search query", async () => {
    wrap(derived());
    await userEvent.click(screen.getByRole("button", { name: /add project/i }));
    // Every deployment in the store is offered, across namespaces.
    expect(await screen.findByRole("option", { name: /api/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /canada-hires/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /web/i })).toBeInTheDocument();
    // Typing narrows the list to matching <namespace>/<deployment> ids.
    await userEvent.type(screen.getByLabelText(/search deployments/i), "canada");
    expect(screen.getByRole("option", { name: /canada-hires/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^api/i })).not.toBeInTheDocument();
  });

  it("adds a linked deployment directly to scope.projects", async () => {
    wrap(derived());
    await userEvent.click(screen.getByRole("button", { name: /add project/i }));
    await userEvent.click(await screen.findByRole("option", { name: /canada-hires/i }));
    // canada-hires resolves linked → added straight to scope, no modal.
    await vi.waitFor(() =>
      expect(lastSetAutofix()).toMatchObject({
        action: "setAutofix",
        autofixScope: { projects: ["default/canada-hires"] },
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the Link modal (prefilled) when picking an unlinked deployment", async () => {
    wrap(derived());
    await userEvent.click(screen.getByRole("button", { name: /add project/i }));
    await userEvent.click(await screen.findByRole("option", { name: /^api/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/api · creates a GitOps source/i)).toBeInTheDocument();
    // Not added until the source is created.
    expect(setAutofixBodies).toHaveLength(0);
  });

  it("surfaces an error (no modal, no add) when the link-status check fails", async () => {
    // The GET /api/git/link read itself fails — distinct from a real "unlinked"
    // result. We must NOT assume unlinked / open the modal / add to scope.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/api/assistant")) {
          const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
          if (body.action === "setAutofix") setAutofixBodies.push(body);
          return new Response(JSON.stringify({ success: true, stdout: "", stderr: "" }));
        }
        if (url.includes("/api/git/link")) {
          return new Response(JSON.stringify({ error: "link check boom" }), { status: 500 });
        }
        return new Response("{}");
      }),
    );
    wrap(derived());
    await userEvent.click(screen.getByRole("button", { name: /add project/i }));
    await userEvent.click(await screen.findByRole("option", { name: /^api/i }));
    // Inline error + retry affordance.
    expect(await screen.findByText(/couldn.t check api/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    // The error path opens NO modal and writes NO scope.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(setAutofixBodies).toHaveLength(0);
  });

  it("adds the project to scope after linking an unlinked pick", async () => {
    wrap(derived());
    await userEvent.click(screen.getByRole("button", { name: /add project/i }));
    await userEvent.click(await screen.findByRole("option", { name: /^api/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(
      within(dialog).getByLabelText(/repository url/i),
      "https://github.com/tyrel/api",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: /create source & link/i }));
    // The link mutation fired for default/api, then it was opted into scope.
    await vi.waitFor(() => expect(linkBodies).toHaveLength(1));
    expect(linkBodies[0]).toMatchObject({ namespace: "default", deployment: "api" });
    await vi.waitFor(() =>
      expect(lastSetAutofix()).toMatchObject({
        action: "setAutofix",
        autofixScope: { projects: ["default/api"] },
      }),
    );
  });
});

describe("AutoFixTab — recent pull requests", () => {
  const prs: AssistantPullRequest[] = [
    {
      at: new Date().toISOString(),
      fingerprint: "fp1",
      filePath: "k8s/deploy.yaml",
      incident: "OOMKilled",
      app: "default/canada-hires",
      repo: "https://github.com/tyrel/canada-hires",
      branch: "rigel/fix-oom-7f3",
      prUrl: "https://github.com/tyrel/canada-hires/pull/7",
      title: "Raise memory limit for canada-hires",
      summary: "opened",
      status: "open",
      kind: "config",
    },
    {
      at: new Date().toISOString(),
      fingerprint: "fp2",
      filePath: "k8s/probe.yaml",
      incident: "probe",
      app: "default/signups",
      repo: "https://github.com/tyrel/rigel-signups",
      branch: "rigel/fix-probe-d41",
      prUrl: "https://github.com/tyrel/rigel-signups/pull/3",
      title: "Correct readiness probe path",
      summary: "merged",
      status: "merged",
      kind: "config",
    },
    {
      at: new Date().toISOString(),
      fingerprint: "fp3",
      filePath: "k8s/env.yaml",
      incident: "boom",
      app: "default/api",
      repo: "https://github.com/tyrel/api",
      title: "Failed fix attempt",
      summary: "error: push rejected",
      status: "failed",
      kind: "config",
    },
  ];

  it("renders open/merged/failed badges, titles, and the open-in-browser link", () => {
    wrap(derived({ pullRequests: prs }));
    expect(screen.getByText("Raise memory limit for canada-hires")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Merged")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    // The summary header counts each status.
    expect(screen.getByText("1 open · 1 merged · 1 failed")).toBeInTheDocument();
    // Open PRs link out; the failed one (no prUrl) has no link.
    const link = screen.getByRole("link", { name: /open Raise memory limit/i });
    expect(link).toHaveAttribute("href", "https://github.com/tyrel/canada-hires/pull/7");
    expect(screen.queryByRole("link", { name: /open Failed fix attempt/i })).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no pull requests", () => {
    wrap(derived({ pullRequests: [] }));
    expect(screen.getByText(/no pull requests yet/i)).toBeInTheDocument();
  });
});
