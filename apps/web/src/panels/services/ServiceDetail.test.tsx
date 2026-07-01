// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));

import { ServiceDetail } from "./ServiceDetail";
import { useCluster } from "@/store/cluster";
import type { Service } from "./types";

beforeEach(() => useCluster.setState({ resources: {} }));

const svc: Service = {
  metadata: { name: "cert-manager", namespace: "cert-manager", uid: "s1", creationTimestamp: new Date(Date.now() - 3 * 86400_000).toISOString(), labels: {} },
  spec: {
    type: "ClusterIP",
    clusterIP: "10.43.41.236",
    selector: { "app.kubernetes.io/name": "cert-manager" },
    ports: [{ name: "http-metrics", port: 9402, targetPort: "http-metrics", protocol: "TCP" }],
  },
};

function renderDetail(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("ServiceDetail", () => {
  it("renders port chip, cluster IP, humanized age and selector chip", () => {
    renderDetail(<ServiceDetail service={svc} />);
    expect(screen.getByText("9402")).toBeTruthy();
    expect(screen.getByText("http-metrics")).toBeTruthy();
    expect(screen.getByText("10.43.41.236")).toBeTruthy();
    expect(screen.getByText("3 days")).toBeTruthy();
    // selector chip renders key= and value
    expect(screen.getByText("app.kubernetes.io/name=")).toBeTruthy();
    expect(screen.getByText("cert-manager")).toBeTruthy();
  });
});
