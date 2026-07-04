// apps/web/src/panels/assistant/audits/useReliabilityAudit.test.ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReliabilityAudit } from "./useReliabilityAudit";
import { useCluster } from "@/store/cluster";

vi.mock("@/lib/ws", () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() }));
import { subscribe, unsubscribe } from "@/lib/ws";

beforeEach(() => {
  vi.clearAllMocks();
  useCluster.setState({ resources: {} });
});

describe("useReliabilityAudit", () => {
  it("subscribes to the workload/PDB/HPA kinds and unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useReliabilityAudit());
    expect(subscribe).toHaveBeenCalledWith("poddisruptionbudgets", "*");
    expect(subscribe).toHaveBeenCalledWith("horizontalpodautoscalers", "*");
    unmount();
    expect(unsubscribe).toHaveBeenCalledWith("deployments", "*");
  });

  it("returns findings + counts computed from the store", () => {
    useCluster.setState({
      resources: {
        deployments: {
          "default/web": {
            metadata: { name: "web", namespace: "default" },
            spec: { replicas: 1, template: { metadata: { labels: {} }, spec: { containers: [{ name: "web", image: "nginx:1.27.0", livenessProbe: {}, readinessProbe: {}, resources: { requests: { cpu: "1", memory: "1Gi" } } }] } } },
          },
        },
      },
    });
    const { result } = renderHook(() => useReliabilityAudit());
    expect(result.current.findings.some((f) => f.type === "singleReplica")).toBe(true);
    expect(result.current.counts.workloadsAffected).toBe(1);
  });
});
