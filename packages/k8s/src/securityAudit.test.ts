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
});
