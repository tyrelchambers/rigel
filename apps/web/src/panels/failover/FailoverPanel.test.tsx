// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FailoverPanel from "./FailoverPanel";

const config = {
  configured: false,
  provider: "digitalocean",
  tokenSet: false,
  spacesKeySet: false,
  spacesSecretSet: false,
  region: "tor1",
  nodeSize: "s-4vcpu-8gb",
  nodeCount: 1,
  cluster: { context: "home", namespace: "rigel", secret: "rigel-user-config", state: "ok" },
};

const state = { configured: config, plan: undefined as unknown, job: undefined as unknown };

vi.mock("@/lib/api", () => ({
  useFailoverConfig: () => ({ data: state.configured }),
  useFailoverState: () => ({ data: {} }),
  useFailoverPlan: () => ({ data: state.plan, mutate: vi.fn(), isPending: false }),
  useFailoverJob: () => ({ data: state.job }),
  useFailoverRun: () => ({ data: undefined, mutate: vi.fn(), isPending: false, error: null }),
  useFailoverEdgeConfirm: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useFailoverScaleHome: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useFailoverRestore: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

function renderPanel() {
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <FailoverPanel />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const emptyPlan = {
  members: [],
  findings: [],
  plans: [],
  blockers: [],
  outbound: [],
  workloadsToScale: [],
  endpointRewrites: [],
};

beforeEach(() => {
  state.configured = config;
  state.plan = undefined;
  state.job = undefined;
});

describe("FailoverPanel", () => {
  it("shows the run steps while a failover is in flight", () => {
    state.configured = { ...config, configured: true };
    state.job = {
      status: "running",
      steps: [{ id: "provision", label: "Provision DOKS", status: "running", detail: "tor1" }],
    };
    renderPanel();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Provision DOKS")).toBeInTheDocument();
  });

  it("sends an unconfigured cluster to Settings", () => {
    renderPanel();
    expect(screen.getByText(/configure a digitalocean destination first/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open failover settings/i })).toHaveAttribute("href", "/settings?tab=failover");
  });

  it("shows the from and to of every connection rewrite", () => {
    state.configured = { ...config, configured: true };
    state.plan = {
      ...emptyPlan,
      endpointRewrites: [
        {
          subject: { kind: "Secret", namespace: "default", name: "rigel-api" },
          key: "DATABASE_URL",
          from: "postgres://a:b@postgres-pooler.default:5432/rigel",
          to: "postgres://a:b@postgres-rw.default.svc.cluster.local:5432/rigel",
          via: "postgres-pooler",
        },
      ],
    };
    renderPanel();
    expect(screen.getByText(/connections \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText(/from postgres:\/\/a:b@postgres-pooler\.default:5432\/rigel/)).toBeInTheDocument();
    expect(screen.getByText(/to postgres:\/\/a:b@postgres-rw\.default\.svc\.cluster\.local:5432\/rigel/)).toBeInTheDocument();
  });

  it("says so when nothing needs repointing", () => {
    state.configured = { ...config, configured: true };
    state.plan = emptyPlan;
    renderPanel();
    expect(screen.getByText(/already resolves on the target under the same name/i)).toBeInTheDocument();
  });
});
