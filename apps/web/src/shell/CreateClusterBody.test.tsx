// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const tools = { dockerRunning: true, kind: true, k3d: false, os: "mac" as const, installer: null };
vi.mock("@/lib/api", () => ({
  useClusterTools: () => ({ data: tools, refetch: vi.fn(), isFetching: false }),
}));
vi.mock("@/lib/ws", () => ({
  sendClusterCreate: vi.fn(),
  onClusterEvent: () => () => {},
}));

import { CreateClusterBody, clusterToolsReady } from "./CreateClusterBody";
import { WizardHostContext } from "./onboarding/wizardHost";

function wrap(host?: { actionSlot: HTMLElement | null }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const body = (
    <QueryClientProvider client={qc}>
      <CreateClusterBody active onDone={vi.fn()} />
    </QueryClientProvider>
  );
  return render(
    host ? (
      <WizardHostContext.Provider value={{ actionSlot: host.actionSlot, setSubflow: vi.fn() }}>
        {body}
      </WizardHostContext.Provider>
    ) : (
      body
    ),
  );
}

beforeEach(() => {
  Object.assign(tools, { dockerRunning: true, kind: true, k3d: false });
});

describe("CreateClusterBody tool choice", () => {
  // The old rule was "only show Tool when BOTH are installed", which meant the
  // common case (one installed) showed no tool row at all: the form looked like
  // it was missing an option and never said which tool was about to run.
  it("lists both tools even when only one is installed", () => {
    wrap();
    expect(screen.getByRole("button", { name: /kind/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /k3d/i })).toBeInTheDocument();
  });

  it("says which tool was found and which was not", () => {
    wrap();
    expect(screen.getByRole("button", { name: /kind/i })).toHaveTextContent("detected");
    expect(screen.getByRole("button", { name: /k3d/i })).toHaveTextContent("not installed");
  });

  it("does not let the user pick a tool that is not installed", () => {
    wrap();
    expect(screen.getByRole("button", { name: /k3d/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /kind/i })).toBeEnabled();
  });
});

describe("CreateClusterBody hosting", () => {
  it("keeps its own intro and button row outside the wizard", () => {
    wrap();
    expect(screen.getByText(/run the cluster as Docker containers/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^create cluster$/i })).toBeInTheDocument();
  });

  it("gives up its intro and Cancel to the wizard, and puts Create in the host slot", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    wrap({ actionSlot: slot });

    expect(screen.queryByText(/run the cluster as Docker containers/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^cancel$/i })).not.toBeInTheDocument();
    expect(slot).toHaveTextContent("Create cluster");
  });

  it("offers Re-check instead of Create while the machine is not ready", () => {
    Object.assign(tools, { dockerRunning: false });
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    wrap({ actionSlot: slot });

    expect(slot).toHaveTextContent("Re-check");
    expect(slot).not.toHaveTextContent("Create cluster");
    expect(screen.getByText("Docker is not running")).toBeInTheDocument();
    expect(screen.getByText(/Start Docker, then re-check/)).toBeInTheDocument();
  });
});

describe("clusterToolsReady", () => {
  it("needs Docker up and at least one tool", () => {
    expect(clusterToolsReady({ ...tools, dockerRunning: true, kind: true, k3d: false })).toBe(true);
    expect(clusterToolsReady({ ...tools, dockerRunning: true, kind: false, k3d: true })).toBe(true);
    expect(clusterToolsReady({ ...tools, dockerRunning: false, kind: true, k3d: true })).toBe(false);
    expect(clusterToolsReady({ ...tools, dockerRunning: true, kind: false, k3d: false })).toBe(false);
    expect(clusterToolsReady(undefined)).toBe(false);
  });
});
