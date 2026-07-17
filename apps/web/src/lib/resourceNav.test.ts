import { describe, it, expect, vi, beforeEach } from "vitest";
import { focusKeyFor, goToResource, goToLogs } from "./resourceNav";
import { useCluster } from "@/store/cluster";

beforeEach(() => useCluster.getState().setFocusRequest(null));

describe("focusKeyFor", () => {
  it("prefers uid", () => {
    expect(focusKeyFor({ metadata: { uid: "u1", name: "a", namespace: "prod" } })).toBe("u1");
  });
  it("falls back to namespace/name", () => {
    expect(focusKeyFor({ metadata: { name: "a", namespace: "prod" } })).toBe("prod/a");
  });
});

describe("goToResource", () => {
  it("navigates to the kind's route and sets a matching focusRequest", () => {
    const navigate = vi.fn();
    goToResource(navigate, { kind: "services", name: "backend", namespace: "prod", uid: "s1", key: "prod/backend", status: "ok" });
    expect(navigate).toHaveBeenCalledWith("/services");
    expect(useCluster.getState().focusRequest).toEqual({ route: "/services", kind: "service", key: "s1" });
  });

  it("uses namespace/name as the key when there is no uid", () => {
    const navigate = vi.fn();
    goToResource(navigate, { kind: "configmaps", name: "cfg", namespace: "prod", key: "prod/cfg", status: "ok" });
    expect(useCluster.getState().focusRequest!.key).toBe("prod/cfg");
  });
});

describe("goToLogs", () => {
  it("routes to /logs and sets a name-based pod focusRequest the Logs panel can match", () => {
    const navigate = vi.fn();
    goToLogs(navigate, { kind: "pod", namespace: "prod", name: "api-7d9f-abc" });
    expect(navigate).toHaveBeenCalledWith("/logs");
    // ns/name (not uid) so LogsPanel's ns/name-keyed sidebar can resolve it.
    expect(useCluster.getState().focusRequest).toEqual({ route: "/logs", kind: "pod", key: "prod/api-7d9f-abc" });
  });

  it("carries the workload kind through for a deployment", () => {
    const navigate = vi.fn();
    goToLogs(navigate, { kind: "deployment", namespace: "prod", name: "api" });
    expect(useCluster.getState().focusRequest).toEqual({ route: "/logs", kind: "deployment", key: "prod/api" });
  });

  it("defaults the namespace to 'default' when omitted", () => {
    const navigate = vi.fn();
    goToLogs(navigate, { kind: "pod", name: "solo" });
    expect(useCluster.getState().focusRequest!.key).toBe("default/solo");
  });
});
