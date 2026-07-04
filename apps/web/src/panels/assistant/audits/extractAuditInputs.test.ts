// apps/web/src/panels/assistant/audits/extractAuditInputs.test.ts
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
});
