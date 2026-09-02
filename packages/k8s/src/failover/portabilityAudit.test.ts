import { describe, expect, it } from "vitest";
import { auditPortability } from "./portabilityAudit";
import type { TargetProfile } from "./types";

const doks: TargetProfile = {
  storageClasses: ["do-block-storage"],
  defaultStorageClass: "do-block-storage",
  ingressClasses: ["traefik"],
  loadBalancerKind: "LoadBalancer",
  hasCertManager: true,
  hasCnpg: true,
  hasTraefikCrds: true,
  nodeCount: 1,
};

describe("auditPortability", () => {
  it("flags nfs PVCs as blockers", () => {
    const f = auditPortability(
      [{ kind: "PersistentVolumeClaim", metadata: { name: "data", namespace: "default" }, spec: { storageClassName: "nfs" } }],
      doks,
    );
    expect(f.map((x) => x.rule)).toEqual(expect.arrayContaining(["nfsBackedVolume", "storageClassMissing"]));
  });

  it("rewrites a home ingress class to traefik", () => {
    const f = auditPortability(
      [{ kind: "Ingress", metadata: { name: "web", namespace: "default" }, spec: { ingressClassName: "nginx" } }],
      doks,
    );
    expect(f.find((x) => x.rule === "ingressClassMissing")?.rewrite?.to).toBe("traefik");
  });

  it("blocks a Tailscale address baked into a spec", () => {
    const f = auditPortability(
      [{ kind: "ConfigMap", metadata: { name: "cfg", namespace: "default" }, spec: { extra: "http://100.96.213.121:80" } }],
      doks,
    );
    expect(f.some((x) => x.rule === "tailnetAddressInSpec")).toBe(true);
  });

  it("rewrites in-cluster barman to pg_dump rather than silently dumping", () => {
    const f = auditPortability(
      [
        {
          kind: "ObjectStore",
          metadata: { name: "postgres-garage", namespace: "default" },
          spec: { configuration: { endpointURL: "http://garage-s3.default.svc.cluster.local:3900" } },
        },
      ],
      doks,
    );
    const hit = f.find((x) => x.rule === "backupTargetIsInsideSourceCluster");
    expect(hit?.severity).toBe("rewrite");
    expect(hit?.rewrite?.to).toBe("pgDump");
  });

  it("warns on :latest image tags", () => {
    const f = auditPortability(
      [
        {
          kind: "Deployment",
          metadata: { name: "web", namespace: "default" },
          spec: { template: { spec: { containers: [{ image: "ghcr.io/acme/web:latest" }] } } },
        },
      ],
      doks,
    );
    expect(f.some((x) => x.rule === "mutableImageTag")).toBe(true);
  });

  it("blocks a missing image pull secret", () => {
    const f = auditPortability(
      [
        {
          kind: "Deployment",
          metadata: { name: "web", namespace: "default" },
          spec: { template: { spec: { imagePullSecrets: [{ name: "ghcr-creds" }], containers: [{ image: "ghcr.io/acme/web:1" }] } } },
        },
      ],
      doks,
    );
    expect(f.some((x) => x.rule === "imagePullSecretMissing")).toBe(true);
  });
});
