// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));

import { WorkloadDetail } from "./WorkloadDetail";
import { useCluster } from "@/store/cluster";
import type { StatefulSet, CronJob, Job, DaemonSet } from "./types";

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

  it("renders Job conditions with reason", () => {
    const job: Job = {
      metadata: { name: "backup", namespace: "prod", uid: "j1" },
      spec: { completions: 1, template: { spec: { containers: [{ name: "dump", image: "pg-dump:1" }] } } },
      status: {
        succeeded: 0,
        conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "too many retries" }],
      },
    };
    renderDetail(<WorkloadDetail workload={job} kind="jobs" />);
    expect(screen.getByText("Conditions")).toBeTruthy();
    expect(screen.getByText("Failed=True")).toBeTruthy();
    expect(screen.getByText("BackoffLimitExceeded")).toBeTruthy();
  });

  it("renders DaemonSet spec fields", () => {
    const ds: DaemonSet = {
      metadata: { name: "cni", namespace: "kube-system", uid: "d1" },
      spec: { template: { spec: { containers: [{ name: "agent", image: "cni:2" }] } } },
      status: { numberReady: 4, desiredNumberScheduled: 5, numberAvailable: 4, updatedNumberScheduled: 5 },
    };
    renderDetail(<WorkloadDetail workload={ds} kind="daemonsets" />);
    expect(screen.getByText("cni:2")).toBeTruthy();
    // "Desired" field value 5 renders in the grid
    expect(screen.getByText("Desired")).toBeTruthy();
  });
});
