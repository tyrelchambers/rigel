// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));

import ConnectivityPanel from "./ConnectivityPanel";
import { useCluster } from "@/store/cluster";
import type { Service } from "../services/types";
import type { Pod } from "../pods/types";

// One internal ClusterIP service with a single matching, ready pod → computeFlows
// yields exactly one internal flow. The collapsed row renders "1/1" for the pod
// count but NOT the detail's "PODS · 1" SectionLabel nor the pod name "api-1";
// both appear only after the chevron expands ConnectivityDetail.
const svc: Service = {
  metadata: { name: "api", namespace: "default", uid: "svc1" },
  spec: { type: "ClusterIP", selector: { app: "api" } },
};
const pod: Pod = {
  metadata: { name: "api-1", namespace: "default", uid: "pod1", labels: { app: "api" } },
  spec: { containers: [{ name: "c" }] },
  status: { phase: "Running", containerStatuses: [{ name: "c", ready: true, restartCount: 0 }] },
};

beforeEach(() => {
  useCluster.setState({
    resources: { services: { "default/api": svc }, pods: { "default/api-1": pod }, ingresses: {} },
    isLoading: false,
    error: null,
    namespaceFilter: null,
  });
});

function renderPanel() {
  return render(
    <MemoryRouter>
      <ConnectivityPanel />
    </MemoryRouter>,
  );
}

describe("ConnectivityPanel expansion", () => {
  it("clicking a flow row's chevron reveals the ConnectivityDetail body", () => {
    renderPanel();
    // Collapsed: detail body not rendered.
    expect(screen.queryByText("PODS · 1")).toBeNull();
    expect(screen.queryByText("api-1")).toBeNull();
    // Expand the (single) flow row.
    fireEvent.click(screen.getByLabelText("Expand"));
    // Expanded: ConnectivityDetail's SectionLabel + pod name now present.
    expect(screen.getByText("PODS · 1")).toBeTruthy();
    expect(screen.getByText("api-1")).toBeTruthy();
  });
});
