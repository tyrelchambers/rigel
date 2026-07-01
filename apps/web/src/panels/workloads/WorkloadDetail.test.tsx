// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));

import { WorkloadDetail } from "./WorkloadDetail";
import { useCluster } from "@/store/cluster";
import type { StatefulSet, CronJob } from "./types";

beforeEach(() => {
  useCluster.setState({ resources: {} });
});

function renderDetail(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("WorkloadDetail", () => {
  it("renders StatefulSet spec fields, container cards and volume claim templates", () => {
    const sts: StatefulSet = {
      metadata: { name: "db", namespace: "prod", uid: "s1", labels: { app: "db" } },
      spec: {
        replicas: 3,
        serviceName: "db-svc",
        selector: { matchLabels: { app: "db" } },
        template: { spec: { containers: [{ name: "postgres", image: "postgres:16" }] } },
        volumeClaimTemplates: [{ metadata: { name: "data" }, spec: { storageClassName: "fast", resources: { requests: { storage: "10Gi" } } } }],
      },
      status: { readyReplicas: 3, replicas: 3 },
    };
    renderDetail(<WorkloadDetail workload={sts} kind="statefulsets" />);
    expect(screen.getByText("db-svc")).toBeTruthy();
    expect(screen.getByText("postgres:16")).toBeTruthy();
    expect(screen.getByText("Volume Claim Templates")).toBeTruthy();
    expect(screen.getByText("data")).toBeTruthy();
  });

  it("renders CronJob active jobs", () => {
    const cron: CronJob = {
      metadata: { name: "nightly", namespace: "prod", uid: "c1" },
      spec: { schedule: "0 0 * * *", jobTemplate: { spec: { template: { spec: { containers: [{ name: "runner", image: "alpine" }] } } } } },
      status: { active: [{ name: "nightly-123" }] },
    };
    renderDetail(<WorkloadDetail workload={cron} kind="cronjobs" />);
    expect(screen.getByText("0 0 * * *")).toBeTruthy();
    expect(screen.getByText("Active Jobs")).toBeTruthy();
    expect(screen.getByText("nightly-123")).toBeTruthy();
  });
});
