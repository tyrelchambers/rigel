// packages/k8s/src/extractAuditInputs.test.ts
import { describe, it, expect } from "vitest";
import { extractAuditInputs } from "./extractAuditInputs";

describe("extractAuditInputs", () => {
  it("maps a Deployment's spec into an AuditWorkload", () => {
    const resources = {
      deployments: {
        "default/web": {
          metadata: { name: "web", namespace: "default" },
          spec: {
            replicas: 3,
            template: {
              metadata: { labels: { app: "web" } },
              spec: {
                affinity: { podAntiAffinity: {} },
                volumes: [{ name: "data", hostPath: { path: "/data" } }],
                containers: [
                  {
                    name: "web",
                    image: "nginx:1.27.0",
                    livenessProbe: {},
                    resources: { requests: { cpu: "100m" } },
                  },
                ],
              },
            },
          },
        },
      },
    };
    const { workloads } = extractAuditInputs(resources);
    expect(workloads).toHaveLength(1);
    const w = workloads[0];
    expect(w).toMatchObject({ kind: "Deployment", name: "web", namespace: "default", replicas: 3 });
    expect(w.labels).toEqual({ app: "web" });
    expect(w.hasAntiAffinity).toBe(true);
    expect(w.hasHostPath).toBe(true);
    expect(w.containers[0]).toMatchObject({
      name: "web",
      image: "nginx:1.27.0",
      hasLiveness: true,
      hasReadiness: false,
      hasCpuRequest: true,
      hasMemRequest: false,
    });
  });

  it("defaults replicas to 1 and namespace to default; reads PDB and HPA slices", () => {
    const resources = {
      statefulsets: { "x/db": { metadata: { name: "db" }, spec: { template: { spec: { containers: [] } } } } },
      poddisruptionbudgets: { "default/pdb": { metadata: { namespace: "default" }, spec: { selector: { matchLabels: { app: "web" } } } } },
      horizontalpodautoscalers: {
        "default/hpa": {
          metadata: { namespace: "default" },
          spec: { scaleTargetRef: { kind: "Deployment", name: "web" }, minReplicas: 2 },
        },
      },
    };
    const out = extractAuditInputs(resources);
    expect(out.workloads[0]).toMatchObject({ kind: "StatefulSet", name: "db", namespace: "default", replicas: 1 });
    expect(out.pdbs).toEqual([{ namespace: "default", selector: { app: "web" } }]);
    expect(out.hpas).toEqual([{ namespace: "default", targetKind: "Deployment", targetName: "web", minReplicas: 2 }]);
  });

  it("maps security fields: privileged, hostNetwork/pod-level, root, added capabilities, host ports", () => {
    const resources = {
      deployments: {
        "default/risky": {
          metadata: { name: "risky", namespace: "default" },
          spec: {
            replicas: 1,
            template: {
              metadata: { labels: {} },
              spec: {
                hostNetwork: true,
                hostPID: true,
                hostIPC: false,
                securityContext: { runAsNonRoot: true, runAsUser: 1000 },
                containers: [
                  {
                    name: "app",
                    image: "app:1.0",
                    securityContext: {
                      privileged: true,
                      allowPrivilegeEscalation: true,
                      runAsNonRoot: false,
                      runAsUser: 0,
                      readOnlyRootFilesystem: false,
                      capabilities: { add: ["NET_ADMIN", "SYS_TIME"] },
                    },
                    ports: [{ hostPort: 8080 }, { containerPort: 9090 }],
                  },
                ],
              },
            },
          },
        },
      },
    };
    const { workloads } = extractAuditInputs(resources);
    const w = workloads[0];
    expect(w.hostNetwork).toBe(true);
    expect(w.hostPID).toBe(true);
    expect(w.hostIPC).toBe(false);
    expect(w.podRunAsNonRoot).toBe(true);
    expect(w.podRunAsUser).toBe(1000);
    const c = w.containers[0];
    expect(c.privileged).toBe(true);
    expect(c.allowPrivilegeEscalation).toBe(true);
    // Explicit container-level false must be preserved faithfully (not coerced).
    expect(c.runAsNonRoot).toBe(false);
    expect(c.runAsUser).toBe(0);
    expect(c.readOnlyRootFilesystem).toBe(false);
    expect(c.addedCapabilities).toEqual(["NET_ADMIN", "SYS_TIME"]);
    expect(c.hostPorts).toEqual([8080]);
  });

  it("maps performance fields: cpu/mem limit presence and parsed values", () => {
    const resources = {
      deployments: {
        "default/api": {
          metadata: { name: "api", namespace: "default" },
          spec: {
            replicas: 1,
            template: {
              metadata: { labels: {} },
              spec: {
                containers: [
                  {
                    name: "api",
                    resources: {
                      requests: { cpu: "100m", memory: "128Mi" },
                      limits: { cpu: "500m", memory: "512Mi" },
                    },
                  },
                  {
                    name: "sidecar",
                    resources: { requests: {} },
                  },
                ],
              },
            },
          },
        },
      },
    };
    const { workloads } = extractAuditInputs(resources);
    const [main, sidecar] = workloads[0].containers;
    expect(main.hasCpuLimit).toBe(true);
    expect(main.hasMemLimit).toBe(true);
    expect(main.cpuLimit).toBe(0.5);
    expect(main.memLimit).toBe(512 * 1024 * 1024);
    expect(sidecar.hasCpuLimit).toBe(false);
    expect(sidecar.hasMemLimit).toBe(false);
    expect(sidecar.cpuLimit).toBeUndefined();
    expect(sidecar.memLimit).toBeUndefined();
  });
});
