// apps/web/src/panels/assistant/audits/extractAuditInputs.ts
// Adapter: turn the live Zustand cluster store (raw kubectl -o json objects,
// keyed by watch-kind then name) into the normalized inputs the pure
// reliability engine consumes. Mirrors rightsizing/aggregate.ts:buildRightSizing.
import type {
  AuditWorkload,
  AuditPdb,
  AuditHpa,
  AuditContainer,
  ReliabilityAuditInput,
  ReliabilityWorkloadKind,
} from "@rigel/k8s";

type Dict = Record<string, unknown>;

interface RawContainer {
  name: string;
  image?: string;
  livenessProbe?: unknown;
  readinessProbe?: unknown;
  resources?: { requests?: Record<string, string> };
}

interface RawWorkload {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    replicas?: number;
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec?: {
        affinity?: { podAntiAffinity?: unknown };
        volumes?: Array<{ hostPath?: unknown }>;
        containers?: RawContainer[];
      };
    };
  };
}

interface RawPdb {
  metadata?: { namespace?: string };
  spec?: { selector?: { matchLabels?: Record<string, string> } };
}

interface RawHpa {
  metadata?: { namespace?: string };
  spec?: { scaleTargetRef?: { kind?: string; name?: string }; minReplicas?: number };
}

const WORKLOAD_KINDS: Record<string, ReliabilityWorkloadKind> = {
  deployments: "Deployment",
  statefulsets: "StatefulSet",
  daemonsets: "DaemonSet",
};

function mapContainer(c: RawContainer): AuditContainer {
  const req = c.resources?.requests ?? {};
  return {
    name: c.name,
    image: c.image,
    hasLiveness: c.livenessProbe != null,
    hasReadiness: c.readinessProbe != null,
    hasCpuRequest: req.cpu != null,
    hasMemRequest: req.memory != null,
  };
}

function sliceOf(resources: Dict, kind: string): Record<string, unknown> {
  return (resources[kind] as Record<string, unknown> | undefined) ?? {};
}

export function extractAuditInputs(resources: Dict): ReliabilityAuditInput {
  const workloads: AuditWorkload[] = [];
  for (const [watchKind, kind] of Object.entries(WORKLOAD_KINDS)) {
    for (const obj of Object.values(sliceOf(resources, watchKind))) {
      const w = obj as RawWorkload;
      const podSpec = w.spec?.template?.spec;
      workloads.push({
        kind,
        name: w.metadata?.name ?? "",
        namespace: w.metadata?.namespace ?? "default",
        replicas: w.spec?.replicas ?? 1,
        labels: w.spec?.template?.metadata?.labels ?? {},
        containers: (podSpec?.containers ?? []).map(mapContainer),
        hasAntiAffinity: podSpec?.affinity?.podAntiAffinity != null,
        hasHostPath: (podSpec?.volumes ?? []).some((v) => v.hostPath != null),
      });
    }
  }

  const pdbs: AuditPdb[] = Object.values(sliceOf(resources, "poddisruptionbudgets")).map((obj) => {
    const p = obj as RawPdb;
    return { namespace: p.metadata?.namespace ?? "default", selector: p.spec?.selector?.matchLabels ?? {} };
  });

  const hpas: AuditHpa[] = Object.values(sliceOf(resources, "horizontalpodautoscalers")).map((obj) => {
    const h = obj as RawHpa;
    return {
      namespace: h.metadata?.namespace ?? "default",
      targetKind: h.spec?.scaleTargetRef?.kind ?? "",
      targetName: h.spec?.scaleTargetRef?.name ?? "",
      minReplicas: h.spec?.minReplicas ?? 1,
    };
  });

  return { workloads, pdbs, hpas };
}
