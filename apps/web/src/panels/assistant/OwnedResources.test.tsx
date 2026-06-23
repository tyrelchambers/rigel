// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OwnedResources } from "./OwnedResources";
import { AssistantContext, type AssistantContextValue } from "./AssistantContext";
import { useCluster } from "@/store/cluster";
import type { AssistantDerived } from "./useAssistant";

const navigate = vi.fn();
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => navigate };
});

function derived(overrides: Partial<AssistantDerived> = {}): AssistantDerived {
  return {
    isInstalled: true,
    installedNamespace: "agents",
    agentPod: { metadata: { name: "rigel-assistant-7c9", namespace: "agents" } },
    ...overrides,
  } as AssistantDerived;
}

function wrap(d: AssistantDerived) {
  return render(
    <AssistantContext value={{ d } as unknown as AssistantContextValue}>
      <OwnedResources />
    </AssistantContext>,
  );
}

beforeEach(() => {
  navigate.mockReset();
  useCluster.getState().setNamespaceFilter(null);
});

describe("OwnedResources", () => {
  it("lists the owned objects, including the live pod name", () => {
    wrap(derived());
    expect(screen.getByText("Resources")).toBeInTheDocument();
    expect(screen.getByText("assistant-config")).toBeInTheDocument();
    expect(screen.getByText("rigel-assistant-credentials")).toBeInTheDocument();
    expect(screen.getByText("rigel-assistant-7c9")).toBeInTheDocument(); // live pod name
    // The four access objects + workload all surface (rigel-assistant appears 4x:
    // Deployment, ServiceAccount, ClusterRole, ClusterRoleBinding).
    expect(screen.getAllByText("rigel-assistant").length).toBe(4);
    expect(screen.getByText("ClusterRoleBinding")).toBeInTheDocument();
  });

  it("opens a namespaced object's panel scoped to the agent namespace", async () => {
    wrap(derived());
    await userEvent.click(screen.getByRole("button", { name: "Open Deployment rigel-assistant" }));
    expect(useCluster.getState().namespaceFilter).toBe("agents");
    expect(navigate).toHaveBeenCalledWith("/deployments");
  });

  it("clears the namespace filter for a cluster-scoped object", async () => {
    useCluster.getState().setNamespaceFilter("agents");
    wrap(derived());
    await userEvent.click(screen.getByRole("button", { name: "Open ClusterRole rigel-assistant" }));
    expect(useCluster.getState().namespaceFilter).toBeNull();
    expect(navigate).toHaveBeenCalledWith("/rbac");
  });

  it("renders nothing until the assistant is installed", () => {
    wrap(derived({ isInstalled: false, installedNamespace: null }));
    expect(screen.queryByText("Resources")).not.toBeInTheDocument();
  });
});
