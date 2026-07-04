// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { ConnectivityDetail } from "./ConnectivityDetail";
import type { Flow } from "./types";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderWithLocation(f: Flow) {
  return render(
    <MemoryRouter initialEntries={["/connectivity"]}>
      <ConnectivityDetail flow={f} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function flow(overrides: Partial<Flow> = {}): Flow {
  return {
    id: "default/api",
    hosts: ["example.com"],
    ingressNames: ["web"],
    serviceName: "api",
    namespace: "default",
    serviceType: "ClusterIP",
    serviceExists: true,
    readyPods: 1,
    totalPods: 2,
    pods: [
      { name: "api-1", ready: true, phase: "Running" },
      { name: "api-2", ready: false, phase: "Pending" },
    ],
    isExternal: true,
    issues: [],
    health: "ok",
    ...overrides,
  };
}

function renderDetail(f: Flow) {
  return render(
    <MemoryRouter>
      <ConnectivityDetail flow={f} />
    </MemoryRouter>,
  );
}

describe("ConnectivityDetail", () => {
  it("lists each backing pod by name", () => {
    renderDetail(flow());
    expect(screen.getByText("api-1")).toBeTruthy();
    expect(screen.getByText("api-2")).toBeTruthy();
  });

  it("shows the ingress host → ingress route for external flows", () => {
    renderDetail(flow());
    expect(screen.getAllByText("example.com").length).toBeGreaterThan(0);
    expect(screen.getByText("web")).toBeTruthy();
  });

  it("shows an empty state when the service is missing", () => {
    renderDetail(
      flow({ serviceExists: false, pods: [], readyPods: 0, totalPods: 0, issues: ["Ingress points to a service that doesn't exist"] }),
    );
    expect(screen.getByText("Service does not exist")).toBeTruthy();
  });

  it("clicking a pod navigates to the pods panel", () => {
    renderWithLocation(flow());
    fireEvent.click(screen.getByText("api-1"));
    expect(screen.getByTestId("loc").textContent).toBe("/pods");
  });

  it("clicking an ingress navigates to the ingresses panel", () => {
    renderWithLocation(flow());
    fireEvent.click(screen.getByText("web"));
    expect(screen.getByTestId("loc").textContent).toBe("/ingresses");
  });

  it("internal flow shows 'cluster (internal)' and no ROUTES section", () => {
    renderDetail(flow({ isExternal: false, hosts: [], ingressNames: [] }));
    expect(screen.getByText("cluster (internal)")).toBeTruthy();
    expect(screen.queryByText("ROUTES")).toBeNull();
  });

  it("renders the issues line when the flow has issues", () => {
    renderDetail(flow({ issues: ["Selector matches no pods"], health: "warn" }));
    expect(screen.getByText("Selector matches no pods")).toBeTruthy();
  });
});
