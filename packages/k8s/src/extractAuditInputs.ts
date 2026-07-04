// packages/k8s/src/extractAuditInputs.ts
// Adapter: turn raw kubectl -o json objects (as delivered by the live web
// Zustand cluster store, keyed by watch-kind then name — and, later, a plain
// kubectl JSON list from the CLI) into the normalized inputs the pure
// reliability/security/performance engines consume. Mirrors
// rightsizing/aggregate.ts:buildRightSizing. No web-only deps: only
// ./auditCommon and ./quantity.
import type {
  AuditWorkload,
  AuditWorkloadKind,
  AuditPdb,
  AuditHpa,
  AuditContainer,
} from "./auditCommon";
import type { ReliabilityAuditInput } from "./reliabilityAudit";
import { parseQuantity } from "./quantity";

type Dict = Record<string, unknown>;

interface RawSecurityContext {
  privileged?: boolean;
  allowPrivilegeEscalation?: boolean;
  runAsNonRoot?: boolean;
  runAsUser?: number;
  readOnlyRootFilesystem?: boolean;
  capabilities?: { add?: string[] };
}

interface RawContainer {
  name: string;
  image?: string;
  livenessProbe?: unknown;
  readinessProbe?: unknown;
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
  securityContext?: RawSecurityContext;
  ports?: Array<{ hostPort?: number }>;
}

interface RawPodSecurityContext {
  runAsNonRoot?: boolean;
  runAsUser?: number;
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
        hostNetwork?: boolean;
        hostPID?: boolean;
        hostIPC?: boolean;
        securityContext?: RawPodSecurityContext;
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

const WORKLOAD_KINDS: Record<string, AuditWorkloadKind> = {
  deployments: "Deployment",
  statefulsets: "StatefulSet",
  daemonsets: "DaemonSet",
};

function mapContainer(c: RawContainer): AuditContainer {
  const req = c.resources?.requests ?? {};
  const limits = c.resources?.limits ?? {};
  const sc = c.securityContext ?? {};
  const hasCpuLimit = limits.cpu != null;
  const hasMemLimit = limits.memory != null;
  return {
    name: c.name,
    image: c.image,
    // reliability
    hasLiveness: c.livenessProbe != null,
    hasReadiness: c.readinessProbe != null,
    hasCpuRequest: req.cpu != null,
    hasMemRequest: req.memory != null,
    // security
    privileged: sc.privileged,
    allowPrivilegeEscalation: sc.allowPrivilegeEscalation,
    runAsNonRoot: sc.runAsNonRoot,
    runAsUser: sc.runAsUser,
    readOnlyRootFilesystem: sc.readOnlyRootFilesystem,
    addedCapabilities: sc.capabilities?.add ?? [],
    hostPorts: (c.ports ?? [])
      .filter((p) => p.hostPort != null)
      .map((p) => p.hostPort as number),
    // performance
    hasCpuLimit,
    hasMemLimit,
    cpuLimit: hasCpuLimit ? parseQuantity(limits.cpu as string, "cpu") : undefined,
    memLimit: hasMemLimit ? parseQuantity(limits.memory as string, "memory") : undefined,
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
      const podSc = podSpec?.securityContext ?? {};
      workloads.push({
        kind,
        name: w.metadata?.name ?? "",
        namespace: w.metadata?.namespace ?? "default",
        replicas: w.spec?.replicas ?? 1,
        labels: w.spec?.template?.metadata?.labels ?? {},
        containers: (podSpec?.containers ?? []).map(mapContainer),
        hasAntiAffinity: podSpec?.affinity?.podAntiAffinity != null,
        hasHostPath: (podSpec?.volumes ?? []).some((v) => v.hostPath != null),
        hostNetwork: podSpec?.hostNetwork,
        hostPID: podSpec?.hostPID,
        hostIPC: podSpec?.hostIPC,
        podRunAsNonRoot: podSc.runAsNonRoot,
        podRunAsUser: podSc.runAsUser,
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
