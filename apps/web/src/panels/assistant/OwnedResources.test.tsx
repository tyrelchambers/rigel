// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

/** Seed the cluster store so every owned object resolves as present. */
function seedAllPresent() {
  const ns = (n: string) => ({ [`agents/${n}`]: { metadata: { name: n, namespace: "agents" } } });
  useCluster.setState({
    resources: {
      deployments: ns("rigel-assistant"),
      pods: ns("rigel-assistant-7c9"),
      configmaps: { ...ns("assistant-config"), ...ns("assistant-state"), ...ns("assistant-backups") },
      secrets: { ...ns("rigel-assistant-token"), ...ns("rigel-assistant-credentials") },
      serviceaccounts: ns("rigel-assistant"),
      clusterroles: { "rigel-assistant": { metadata: { name: "rigel-assistant" } } },
      clusterrolebindings: { "rigel-assistant": { metadata: { name: "rigel-assistant" } } },
    },
  });
}

function wrap(d: AssistantDerived) {
  return render(
    <AssistantContext value={{ d } as unknown as AssistantContextValue}>
      <OwnedResources />
    </AssistantContext>,
  );
}

/** The presence dot inside a given resource row. */
function dotIn(kind: string, name: string) {
  const row = screen.getByRole("button", { name: `Open ${kind} ${name}` });
  return within(row).getByRole("img");
}

beforeEach(() => {
  navigate.mockReset();
  useCluster.setState({ resources: {} });
  useCluster.getState().setNamespaceFilter(null);
});

describe("OwnedResources", () => {
  it("lists the owned objects, including the live pod name", () => {
    seedAllPresent();
    wrap(derived());
    expect(screen.getByText("Resources")).toBeInTheDocument();
    expect(screen.getByText("assistant-config")).toBeInTheDocument();
    expect(screen.getByText("rigel-assistant-credentials")).toBeInTheDocument();
    expect(screen.getByText("rigel-assistant-7c9")).toBeInTheDocument(); // live pod name
    expect(screen.getAllByText("rigel-assistant").length).toBe(4); // Deploy, SA, CRole, CRB
    expect(screen.getByText("ClusterRoleBinding")).toBeInTheDocument();
  });

  it("shows a Present dot for objects that exist (incl. a cluster-scoped one)", () => {
    seedAllPresent();
    wrap(derived());
    expect(dotIn("ConfigMap", "assistant-config")).toHaveAccessibleName("Present");
    expect(dotIn("ClusterRole", "rigel-assistant")).toHaveAccessibleName("Present");
  });

  it("shows Missing when the kind is loaded but the object is absent", () => {
    seedAllPresent();
    // configmaps slice is loaded (non-empty) but assistant-backups is gone.
    useCluster.setState({
      resources: {
        ...useCluster.getState().resources,
        configmaps: { "agents/assistant-config": { metadata: { name: "assistant-config" } } },
      },
    });
    wrap(derived());
    expect(dotIn("ConfigMap", "assistant-backups")).toHaveAccessibleName("Missing");
    expect(dotIn("ConfigMap", "assistant-config")).toHaveAccessibleName("Present");
  });

  it("shows Checking before a kind's watch has delivered", () => {
    // No resources seeded → every slice undefined → checking.
    wrap(derived());
    expect(dotIn("Deployment", "rigel-assistant")).toHaveAccessibleName("Checking…");
  });

  it("opens a namespaced object's panel scoped to the agent namespace", async () => {
    seedAllPresent();
    wrap(derived());
    await userEvent.click(screen.getByRole("button", { name: "Open Deployment rigel-assistant" }));
    expect(useCluster.getState().namespaceFilter).toBe("agents");
    expect(navigate).toHaveBeenCalledWith("/deployments");
  });

  it("clears the namespace filter for a cluster-scoped object", async () => {
    seedAllPresent();
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
