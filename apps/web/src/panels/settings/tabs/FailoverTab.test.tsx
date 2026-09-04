// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverTab } from "./FailoverTab";

const remove = vi.fn();
const cluster = { context: "home", namespace: "rigel", secret: "rigel-user-config", state: "ok" as const };

const state = {
  view: {
    configured: false,
    provider: "digitalocean" as const,
    tokenSet: false,
    region: "tor1",
    nodeSize: "s-4vcpu-8gb",
    nodeCount: 2,
    cluster,
  } as Record<string, unknown>,
};

vi.mock("@/lib/api", () => ({
  useFailoverConfig: () => ({ data: state.view }),
  useSaveFailoverConfig: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useDeleteFailoverConfig: () => ({ mutate: remove, isPending: false, error: null }),
  validateFailoverDestination: vi.fn(async () => ({ ok: true, api: { ok: true, email: "me@example.com" } })),
  cloudCheck: vi.fn(async () => ({ cliInstalled: true, extraBinariesInstalled: true, authenticated: true })),
}));

function renderTab() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FailoverTab />
    </QueryClientProvider>,
  );
}

const configured = {
  configured: true,
  provider: "digitalocean" as const,
  tokenSet: true,
  region: "tor1",
  nodeSize: "s-4vcpu-8gb",
  nodeCount: 1,
  objectStore: {
    endpoint: "https://tor1.digitaloceanspaces.com",
    region: "us-east-1",
    bucket: "rigel-failover",
    addressing: "virtualHost" as const,
    accessKeySet: true,
    secretKeySet: true,
  },
  edge: { host: "203.0.113.9", backends: [{ name: "node1", ip: "10.0.0.1" }] },
  cluster,
};

beforeEach(() => {
  remove.mockClear();
  state.view = { ...configured, configured: false, objectStore: undefined, edge: undefined, tokenSet: false };
});

describe("FailoverTab", () => {
  it("offers the wizard rather than a form when nothing is configured", () => {
    renderTab();
    expect(screen.getByRole("button", { name: /set up a destination/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/api token/i)).not.toBeInTheDocument();
  });

  it("summarises a configured destination without showing a secret", () => {
    state.view = configured;
    renderTab();
    expect(screen.getByText("DigitalOcean")).toBeInTheDocument();
    expect(screen.getByText("1 × s-4vcpu-8gb")).toBeInTheDocument();
    expect(screen.getByText(/rigel-failover · https:\/\/tor1\.digitaloceanspaces\.com/)).toBeInTheDocument();
    expect(screen.getByText("203.0.113.9 · 1 servers")).toBeInTheDocument();
    expect(screen.getByText("stored")).toBeInTheDocument();
  });

  it("says when the optional pieces are not set", () => {
    state.view = { ...configured, objectStore: undefined, edge: undefined };
    renderTab();
    expect(screen.getAllByText("Not set")).toHaveLength(2);
  });

  it("asks before removing a destination, and only removes on confirm", () => {
    state.view = configured;
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /remove destination/i }));
    expect(screen.getByText(/remove this destination\?/i)).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(remove).toHaveBeenCalled();
  });

  it("hides the setup button behind the cluster note when the cluster is unreachable", () => {
    state.view = { ...configured, cluster: { ...cluster, state: "unavailable" as const } };
    renderTab();
    expect(screen.queryByRole("button", { name: /edit destination/i })).not.toBeInTheDocument();
  });
});
