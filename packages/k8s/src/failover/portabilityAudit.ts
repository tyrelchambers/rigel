import { imageTagIsMutable } from "../reliabilityAudit";
import type { ClusterObject } from "../workloadClosure";
import { containsTailnetAddress, endpointIsInsideSourceCluster, walkStrings } from "./inClusterEndpoint";
import type { PortabilityFinding, TargetProfile } from "./types";

function subject(o: ClusterObject): PortabilityFinding["subject"] {
  return {
    kind: o.kind ?? "Unknown",
    namespace: o.metadata?.namespace ?? "",
    name: o.metadata?.name ?? "",
  };
}

function finding(
  rule: PortabilityFinding["rule"],
  severity: PortabilityFinding["severity"],
  o: ClusterObject,
  whatsWrong: string,
  rewrite?: PortabilityFinding["rewrite"],
): PortabilityFinding {
  return { rule, severity, subject: subject(o), whatsWrong, ...(rewrite ? { rewrite } : {}) };
}

function specOf(o: ClusterObject): Record<string, unknown> {
  return (o.spec as Record<string, unknown> | undefined) ?? {};
}

function podSpec(o: ClusterObject): Record<string, unknown> {
  const spec = specOf(o);
  const template = spec.template as { spec?: Record<string, unknown> } | undefined;
  return template?.spec ?? spec;
}

function containersOf(o: ClusterObject): Array<Record<string, unknown>> {
  const pod = podSpec(o);
  return [
    ...((pod.containers as Array<Record<string, unknown>> | undefined) ?? []),
    ...((pod.initContainers as Array<Record<string, unknown>> | undefined) ?? []),
  ];
}

function storageClassName(o: ClusterObject): string | undefined {
  const name = specOf(o).storageClassName;
  return typeof name === "string" && name ? name : undefined;
}

export function objectStoreEndpoint(o: ClusterObject): string {
  const spec = specOf(o);
  const config = spec.configuration as { destinationPath?: string; endpointURL?: string } | undefined;
  return config?.endpointURL ?? config?.destinationPath ?? "";
}

export function auditPortability(objects: ClusterObject[], profile: TargetProfile): PortabilityFinding[] {
  const out: PortabilityFinding[] = [];
  const certSecrets = new Set(
    objects
      .filter((o) => o.kind === "Certificate")
      .map((o) => (specOf(o).secretName as string | undefined) ?? ""),
  );

  for (const o of objects) {
    const kind = o.kind ?? "";

    if (kind === "PersistentVolumeClaim") {
      const sc = storageClassName(o);
      if (sc && !profile.storageClasses.includes(sc)) {
        out.push(finding("storageClassMissing", "blocker", o, `StorageClass ${sc} is not on the target.`));
      }
      if (sc === "nfs") {
        out.push(
          finding("nfsBackedVolume", "blocker", o, "This PVC is on nfs, which is the TrueNAS box in the same building."),
        );
      }
    }

    const volumes = (podSpec(o).volumes as Array<Record<string, unknown>> | undefined) ?? [];
    if (volumes.some((v) => v.hostPath)) {
      out.push(finding("hostPathVolume", "blocker", o, "A hostPath volume cannot move to another cluster."));
    }

    const nodeSelector = specOf(o).nodeSelector ?? podSpec(o).nodeSelector;
    if (nodeSelector && typeof nodeSelector === "object" && Object.keys(nodeSelector).length > 0) {
      out.push(
        finding(
          "nodeSelectorUnsatisfiable",
          "rewrite",
          o,
          "A nodeSelector from the home cluster will not match DigitalOcean nodes.",
          { label: "Drop the nodeSelector", from: nodeSelector, to: {} },
        ),
      );
    }

    if (kind === "Ingress") {
      const ic = specOf(o).ingressClassName;
      if (typeof ic === "string" && ic && !profile.ingressClasses.includes(ic)) {
        out.push(finding("ingressClassMissing", "rewrite", o, `IngressClass ${ic} is not on the target.`, {
          label: "Use traefik",
          from: ic,
          to: "traefik",
        }));
      }
      const ann = (o.metadata as { annotations?: Record<string, string> } | undefined)?.annotations ?? {};
      if (Object.keys(ann).some((k) => k.startsWith("nginx.ingress.kubernetes.io/"))) {
        out.push(
          finding(
            "ingressControllerAnnotationsWillBeIgnored",
            "warning",
            o,
            "nginx Ingress annotations are ignored by Traefik.",
          ),
        );
      }
      if (!profile.hasTraefikCrds && ann["traefik.ingress.kubernetes.io/router.middlewares"]) {
        out.push(finding("middlewareCrdMissing", "blocker", o, "Traefik Middleware CRDs are not on the target."));
      }
      const tls = (specOf(o).tls as Array<{ secretName?: string }> | undefined) ?? [];
      for (const t of tls) {
        if (t.secretName && !certSecrets.has(t.secretName) && !profile.hasCertManager) {
          out.push(
            finding(
              "tlsSecretWithoutCertificate",
              "blocker",
              o,
              `TLS Secret ${t.secretName} has no Certificate and cert-manager is not on the target.`,
            ),
          );
        }
      }
    }

    if (kind === "Service" && specOf(o).type === "LoadBalancer") {
      out.push(
        finding(
          "loadBalancerServiceIsLocalOnly",
          "warning",
          o,
          "A LoadBalancer Service on the home cluster is local. The target uses the Traefik LoadBalancer instead.",
        ),
      );
    }

    let tailnet = false;
    walkStrings(o, (s) => {
      if (containsTailnetAddress(s)) tailnet = true;
    });
    if (tailnet) {
      out.push(
        finding("tailnetAddressInSpec", "blocker", o, "A Tailscale 100.64.0.0/10 address is baked into this object."),
      );
    }

    const pulls = (podSpec(o).imagePullSecrets as Array<{ name?: string }> | undefined) ?? [];
    for (const pull of pulls) {
      if (!pull.name) continue;
      const present = objects.some(
        (x) => x.kind === "Secret" && x.metadata?.name === pull.name && x.metadata?.namespace === o.metadata?.namespace,
      );
      if (!present) {
        out.push(
          finding("imagePullSecretMissing", "blocker", o, `Image pull Secret ${pull.name} is not in the closure.`),
        );
      }
    }

    for (const c of containersOf(o)) {
      if (typeof c.image === "string" && imageTagIsMutable(c.image)) {
        out.push(finding("mutableImageTag", "warning", o, `Image ${c.image} is not pinned.`));
      }
    }

    if ((kind === "ObjectStore" || kind === "ObjectStore.barmancloud.cnpg.io") && endpointIsInsideSourceCluster(objectStoreEndpoint(o))) {
      out.push(
        finding(
          "backupTargetIsInsideSourceCluster",
          "rewrite",
          o,
          "Postgres backups archive inside the source cluster. Accept pg_dump for this failover, or add an off-site ObjectStore first.",
          { label: "Dump with pg_dump instead", from: "cnpgBarman", to: "pgDump" },
        ),
      );
    }
  }

  return out;
}
