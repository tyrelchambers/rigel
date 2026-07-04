// packages/k8s/src/securityAudit.test.ts
import { describe, it, expect } from "vitest";
import { analyzeSecurity } from "./securityAudit";
import { type AuditWorkload } from "./auditCommon";

/** A locked-down Deployment that trips NOTHING: non-root, no host namespaces,
 *  allowPrivilegeEscalation:false, readOnlyRootFilesystem:true, no added
 *  capabilities, no hostPort, not privileged. Spread + override per test. */
function healthySecure(over: Partial<AuditWorkload> = {}): AuditWorkload {
  return {
    kind: "Deployment",
    name: "web",
    namespace: "default",
    replicas: 2,
    labels: { app: "web" },
    hasAntiAffinity: true,
    hasHostPath: false,
    hostNetwork: false,
    hostPID: false,
    hostIPC: false,
    podRunAsNonRoot: true,
    containers: [
      {
        name: "web",
        image: "nginx:1.27.0",
        hasLiveness: true,
        hasReadiness: true,
        hasCpuRequest: true,
        hasMemRequest: true,
        privileged: false,
        allowPrivilegeEscalation: false,
        runAsNonRoot: true,
        runAsUser: 1000,
        readOnlyRootFilesystem: true,
        addedCapabilities: [],
        hostPorts: [],
      },
    ],
    ...over,
  };
}

describe("analyzeSecurity", () => {
  it("returns no findings for a healthy, locked-down workload", () => {
    const out = analyzeSecurity({ workloads: [healthySecure()] });
    expect(out).toEqual([]);
  });

  it("flags a privileged container as critical, and clears when not privileged", () => {
    const w = healthySecure();
    w.containers[0].privileged = true;
    const out = analyzeSecurity({ workloads: [w] });
    const f = out.find((x) => x.type === "privilegedContainer");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("critical");
    expect(f?.container).toBe("web");

    const clean = analyzeSecurity({ workloads: [healthySecure()] });
    expect(clean.some((x) => x.type === "privilegedContainer")).toBe(false);
  });

  it("flags a workload sharing the host network namespace as critical, and clears when isolated", () => {
    const w = healthySecure({ hostNetwork: true });
    const out = analyzeSecurity({ workloads: [w] });
    const f = out.find((x) => x.type === "hostNamespace");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("critical");
    expect(f?.container).toBeUndefined();

    const clean = analyzeSecurity({ workloads: [healthySecure()] });
    expect(clean.some((x) => x.type === "hostNamespace")).toBe(false);
  });

  it("emits one hostNamespace finding naming all shared namespaces when multiple flags are set", () => {
    const w = healthySecure({ hostNetwork: true, hostPID: true, hostIPC: true });
    const out = analyzeSecurity({ workloads: [w] });
    const matches = out.filter((x) => x.type === "hostNamespace");
    expect(matches).toHaveLength(1);
    expect(matches[0].rationale).toContain("hostNetwork");
    expect(matches[0].rationale).toContain("hostPID");
    expect(matches[0].rationale).toContain("hostIPC");
  });

  it("flags a container not pinned to non-root as a warning, and clears when it is", () => {
    const w = healthySecure();
    w.containers[0].runAsNonRoot = undefined;
    w.containers[0].runAsUser = undefined;
    w.podRunAsNonRoot = undefined;
    const out = analyzeSecurity({ workloads: [w] });
    const f = out.find((x) => x.type === "runsAsRoot");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBe("web");

    const clean = analyzeSecurity({ workloads: [healthySecure()] });
    expect(clean.some((x) => x.type === "runsAsRoot")).toBe(false);
  });

  it("prefers a container-level runAsUser/runAsNonRoot setting over the pod default", () => {
    // Pod says non-root, but the container explicitly sets runAsUser: 0 (root) —
    // the container setting must win and still trip the finding.
    const rootContainer = healthySecure({ podRunAsNonRoot: true });
    rootContainer.containers[0].runAsNonRoot = undefined;
    rootContainer.containers[0].runAsUser = 0;
    const trips = analyzeSecurity({ workloads: [rootContainer] });
    expect(trips.some((x) => x.type === "runsAsRoot")).toBe(true);

    // Pod has no non-root guarantee at all, but the container sets a non-zero
    // runAsUser — the container setting must win and clear the finding.
    const nonRootContainer = healthySecure({ podRunAsNonRoot: undefined, podRunAsUser: undefined });
    nonRootContainer.containers[0].runAsNonRoot = undefined;
    nonRootContainer.containers[0].runAsUser = 1000;
    const clears = analyzeSecurity({ workloads: [nonRootContainer] });
    expect(clears.some((x) => x.type === "runsAsRoot")).toBe(false);
  });

  it("flags a container that allows privilege escalation as a warning, and clears when disabled", () => {
    const w = healthySecure();
    w.containers[0].allowPrivilegeEscalation = true;
    const out = analyzeSecurity({ workloads: [w] });
    const f = out.find((x) => x.type === "allowsPrivilegeEscalation");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBe("web");

    const clean = analyzeSecurity({ workloads: [healthySecure()] });
    expect(clean.some((x) => x.type === "allowsPrivilegeEscalation")).toBe(false);
  });

  it("flags a container with allowPrivilegeEscalation unset (not explicitly false)", () => {
    const w = healthySecure();
    w.containers[0].allowPrivilegeEscalation = undefined;
    const out = analyzeSecurity({ workloads: [w] });
    expect(out.some((x) => x.type === "allowsPrivilegeEscalation")).toBe(true);
  });

  it("flags added capabilities as a warning, calling out dangerous ones, and clears when none are added", () => {
    const w = healthySecure();
    w.containers[0].addedCapabilities = ["NET_BIND_SERVICE", "SYS_ADMIN"];
    const out = analyzeSecurity({ workloads: [w] });
    const f = out.find((x) => x.type === "addedCapabilities");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("warning");
    expect(f?.container).toBe("web");
    expect(f?.rationale).toContain("SYS_ADMIN");
    expect(f?.rationale).not.toContain("NET_BIND_SERVICE");

    const clean = analyzeSecurity({ workloads: [healthySecure()] });
    expect(clean.some((x) => x.type === "addedCapabilities")).toBe(false);
  });
});
