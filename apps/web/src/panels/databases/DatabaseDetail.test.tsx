// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DatabaseDetail } from "./DatabasesPanel";
import type {
  DatabaseCapabilities,
  DatabaseInstance,
  DatabasePod,
  DatabaseSecret,
} from "./types";

// Minimal non-healthy CNPG instance: failing over, healthy WAL, one primary
// pod that is Running. caps.actions is empty so the action bar is absent.
function instance(): DatabaseInstance {
  return {
    id: "cnpg-1",
    name: "pg",
    namespace: "default",
    kind: "postgres",
    source: "cnpg",
    creationTimestamp: "2026-06-07T00:00:00Z",
    desiredReplicas: 3,
    readyReplicas: 1,
    phaseText: "Failing over",
    isHealthy: false,
    labelSelector: { "cnpg.io/cluster": "pg" },
    cnpgPrimary: "pg-1",
    walArchiving: "healthy",
  };
}

const matchedPods: DatabasePod[] = [
  { name: "pg-1", phase: "Running", node: "node-a", isPrimary: true },
];

const caps: DatabaseCapabilities = { actions: [] };
const secrets: DatabaseSecret[] = [];

function renderDetail() {
  return render(
    <DatabaseDetail
      instance={instance()}
      matchedPods={matchedPods}
      capabilities={caps}
      secrets={secrets}
      onAction={() => {}}
    />,
  );
}

describe("DatabaseDetail state badges", () => {
  it("renders a non-healthy STATUS as an amber/pending StatusBadge", () => {
    renderDetail();
    expect(screen.getByText("Failing over")).toHaveStyle({
      color: "var(--status-pending)",
    });
  });

  it("renders a pod phase as a StatusBadge with no phase dot", () => {
    const { container } = renderDetail();
    expect(screen.getByText("Running")).toHaveStyle({
      color: "var(--status-running)",
    });
    // The phase status dot is gone; the only round pill left in a pod row is
    // the `primary` chip (which is rounded-full but not size-2).
    expect(container.querySelector("span.rounded-full.size-2")).toBeNull();
  });

  it("renders WAL archiving health as a StatusBadge", () => {
    renderDetail();
    expect(screen.getByText("healthy")).toHaveStyle({
      color: "var(--status-running)",
    });
  });
});
