// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClusterStep } from "./ClusterStep";

vi.mock("../CreateClusterBody", () => ({
  CreateClusterBody: () => <div>create-cluster-body</div>,
  clusterToolsReady: () => true,
}));
vi.mock("../ConnectClusterBody", () => ({
  ConnectClusterBody: () => <div>connect-cluster-body</div>,
}));
vi.mock("../ImportKubeconfigPanel", () => ({
  ImportKubeconfigPanel: () => <div>import-kubeconfig-panel</div>,
}));

/** `useContexts()` yields ClusterContext objects, not strings. */
function ctx(name: string, active = true) {
  return { name, cluster: name, server: "https://127.0.0.1:6443", active };
}

function renderStep(contexts: ReturnType<typeof ctx>[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["contexts"], contexts);
  render(
    <QueryClientProvider client={qc}>
      <ClusterStep />
    </QueryClientProvider>,
  );
}

describe("ClusterStep", () => {
  it("lists the three ways to connect", () => {
    renderStep();
    expect(screen.getByText("Create a local cluster")).toBeInTheDocument();
    expect(screen.getByText("Connect a cloud cluster")).toBeInTheDocument();
    expect(screen.getByText("Import a kubeconfig")).toBeInTheDocument();
  });

  it("renders the chosen flow inline instead of opening a dialog", () => {
    renderStep();
    fireEvent.click(screen.getByText("Create a local cluster"));
    expect(screen.getByText("create-cluster-body")).toBeInTheDocument();
    expect(screen.queryByText("Connect a cloud cluster")).not.toBeInTheDocument();
  });

  it("goes back to the card list from an inline flow", () => {
    renderStep();
    fireEvent.click(screen.getByText("Connect a cloud cluster"));
    expect(screen.getByText("connect-cluster-body")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /all connection options/i }));
    expect(screen.getByText("Create a local cluster")).toBeInTheDocument();
  });

  it("shows a connected pill naming the active context once one exists", () => {
    renderStep([ctx("docker-desktop", false), ctx("kind-rigel-dev", true)]);
    expect(screen.getByText(/kind-rigel-dev/)).toBeInTheDocument();
  });

  it("shows no pill when there is no context", () => {
    renderStep([]);
    expect(screen.queryByText(/connected/i)).not.toBeInTheDocument();
  });
});
