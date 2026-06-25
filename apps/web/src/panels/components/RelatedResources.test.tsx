// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const subscribe = vi.fn();
const unsubscribe = vi.fn();
vi.mock("@/lib/ws", () => ({ subscribe: (...a: unknown[]) => subscribe(...a), unsubscribe: (...a: unknown[]) => unsubscribe(...a) }));
const goToResource = vi.fn();
vi.mock("@/lib/resourceNav", async (orig) => ({ ...(await orig<typeof import("@/lib/resourceNav")>()), goToResource: (...a: unknown[]) => goToResource(...a) }));

import { RelatedResources } from "./RelatedResources";
import { useCluster } from "@/store/cluster";

beforeEach(() => {
  subscribe.mockClear(); unsubscribe.mockClear(); goToResource.mockClear();
  useCluster.setState({ resources: {
    services: { "prod/backend": { metadata: { name: "backend", namespace: "prod", uid: "s1" }, spec: { selector: { app: "backend" } } } },
    pods: { "prod/backend-1": { metadata: { name: "backend-1", namespace: "prod", uid: "p1", labels: { app: "backend" } }, spec: { containers: [] }, status: { phase: "Running", containerStatuses: [{ ready: true }] } } },
  } });
});

const deploy = {
  metadata: { name: "backend", namespace: "prod", uid: "d1", labels: { app: "backend" } },
  spec: { selector: { matchLabels: { app: "backend" } }, template: { metadata: { labels: { app: "backend" } }, spec: { containers: [] } } },
};

function renderWith() {
  return render(<MemoryRouter><RelatedResources sourceKind="deployment" source={deploy} /></MemoryRouter>);
}

describe("RelatedResources", () => {
  it("subscribes related kinds for the namespace on mount", () => {
    renderWith();
    expect(subscribe).toHaveBeenCalledWith("services", "prod");
    expect(subscribe).toHaveBeenCalledWith("pods", "prod");
  });

  it("renders grouped related resources and navigates on click", () => {
    renderWith();
    const row = screen.getByText("backend-1");
    fireEvent.click(row);
    expect(goToResource).toHaveBeenCalled();
    expect(goToResource.mock.calls[0][1].kind).toBe("pods");
  });
});
