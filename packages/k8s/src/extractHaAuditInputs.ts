// Adapter: turn raw kubectl -o json objects (nodes + deployments + PDBs) into the
// HaAuditInput the pure HA engine consumes. Mirrors extractAuditInputs' style; the
// HA audit is cluster-scoped so it reads nodes rather than per-workload specs.
import type { HaAuditInput, HaNode, HaComponent, HaComponentRole } from "./haAudit";

type Dict = Record<string, unknown>;

interface RawNode {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { unschedulable?: boolean; taints?: Array<{ key?: string; effect?: string }> };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
}

interface RawDeployment {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: {
    replicas?: number;
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec?: {
        topologySpreadConstraints?: unknown[];
        affinity?: { podAntiAffinity?: unknown };
      };
    };
  };
}

interface RawPdb {
  metadata?: { namespace?: string };
  spec?: { selector?: { matchLabels?: Record<string, string> } };
}

const CONTROL_PLANE_ROLE_LABELS = [
  "node-role.kubernetes.io/control-plane",
  "node-role.kubernetes.io/master",
];
const ZONE_LABEL = "topology.kubernetes.io/zone";

/** Ingress controllers identified by their well-known `app.kubernetes.io/name`.
 *  Kept to an allowlist so an unrelated Deployment named "*ingress*" is never
 *  mistaken for the controller (a false finding). Undetected ingress = no
 *  finding, which is the safe direction. */
const INGRESS_APP_NAMES = new Set(["ingress-nginx", "traefik", "haproxy-ingress", "kong"]);

function sliceOf(resources: Dict, kind: string): Record<string, unknown> {
  return (resources[kind] as Record<string, unknown> | undefined) ?? {};
}

function nodeReady(n: RawNode): boolean {
  return (n.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
}

/** A NoSchedule/NoExecute control-plane taint keeps general workloads off the node. */
function controlPlaneTainted(n: RawNode): boolean {
  return (n.spec?.taints ?? []).some(
    (t) =>
      CONTROL_PLANE_ROLE_LABELS.includes(t.key ?? "") &&
      (t.effect === "NoSchedule" || t.effect === "NoExecute"),
  );
}

function mapNode(n: RawNode): HaNode {
  const labels = n.metadata?.labels ?? {};
  return {
    name: n.metadata?.name ?? "",
    ready: nodeReady(n),
    isControlPlane: CONTROL_PLANE_ROLE_LABELS.some((k) => k in labels),
    schedulable: n.spec?.unschedulable !== true && !controlPlaneTainted(n),
    zone: labels[ZONE_LABEL],
  };
}

/** Classify a Deployment as a cluster-critical singleton, or null to ignore it. */
function componentRole(d: RawDeployment): HaComponentRole | null {
  const name = d.metadata?.name ?? "";
  const namespace = d.metadata?.namespace;
  const labels = d.metadata?.labels ?? {};
  if (namespace === "kube-system") {
    const kApp = labels["k8s-app"];
    if (name === "coredns" || name === "kube-dns" || kApp === "coredns" || kApp === "kube-dns") return "dns";
  }
  if (INGRESS_APP_NAMES.has(labels["app.kubernetes.io/name"] ?? "")) return "ingress";
  return null;
}

/** Are replicas forced apart across nodes/zones? */
function hasSpread(d: RawDeployment): boolean {
  const podSpec = d.spec?.template?.spec;
  const tsc = podSpec?.topologySpreadConstraints;
  if (Array.isArray(tsc) && tsc.length > 0) return true;
  return podSpec?.affinity?.podAntiAffinity != null;
}

/** A PDB selects a component when it is in the same namespace and every label in
 *  its matchLabels is present on the component's pod labels (empty selector
 *  matches every pod in the namespace). */
function pdbSelects(pdb: RawPdb, namespace: string, podLabels: Record<string, string>): boolean {
  if ((pdb.metadata?.namespace ?? "default") !== namespace) return false;
  const selector = pdb.spec?.selector?.matchLabels ?? {};
  return Object.entries(selector).every(([k, v]) => podLabels[k] === v);
}

export function extractHaAuditInputs(resources: Dict): HaAuditInput {
  const nodes = Object.values(sliceOf(resources, "nodes")).map((o) => mapNode(o as RawNode));
  const pdbs = Object.values(sliceOf(resources, "poddisruptionbudgets")).map((o) => o as RawPdb);

  const components: HaComponent[] = [];
  for (const obj of Object.values(sliceOf(resources, "deployments"))) {
    const d = obj as RawDeployment;
    const role = componentRole(d);
    if (!role) continue;
    const namespace = d.metadata?.namespace ?? "default";
    const podLabels = d.spec?.template?.metadata?.labels ?? d.metadata?.labels ?? {};
    components.push({
      role,
      name: d.metadata?.name ?? "",
      namespace,
      replicas: d.spec?.replicas ?? 1,
      spread: hasSpread(d),
      hasPdb: pdbs.some((p) => pdbSelects(p, namespace, podLabels)),
    });
  }

  return { nodes, components };
}
