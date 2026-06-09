import type { Node, NodeCondition } from "./types";

/**
 * Pure display helpers for the Nodes panel. Mirrors the Swift `Node`
 * computed properties (`isReady`, `role`) and the formatting in
 * `Sources/Helmsman/Panels/Nodes/`. See `docs/parity/nodes.md`.
 */

/** True when `status.conditions[type=="Ready"].status == "True"`. */
export function isReady(node: Node): boolean {
  const ready = node.status?.conditions?.find((c) => c.type === "Ready");
  return ready?.status === "True";
}

/**
 * "control-plane" when a control-plane/master role label exists; otherwise
 * "worker".
 */
export function role(node: Node): "control-plane" | "worker" {
  const labels = node.metadata.labels ?? {};
  if (
    "node-role.kubernetes.io/control-plane" in labels ||
    "node-role.kubernetes.io/master" in labels
  ) {
    return "control-plane";
  }
  return "worker";
}

/** True only when `spec.unschedulable === true`. */
export function isCordoned(node: Node): boolean {
  return node.spec?.unschedulable === true;
}

/** `status.addresses[type=="InternalIP"].address`, or "—". */
export function internalIP(node: Node): string {
  return node.status?.addresses?.find((a) => a.type === "InternalIP")?.address ?? "—";
}

/**
 * Conditions other than "Ready" whose `status == "True"` — i.e. active
 * pressure (DiskPressure, MemoryPressure, PIDPressure, NetworkUnavailable…).
 */
export function pressureConditions(node: Node): NodeCondition[] {
  return (node.status?.conditions ?? []).filter(
    (c) => c.type !== "Ready" && c.status === "True",
  );
}

/** CPU quantity as-is ("2", "500m"), or "—" when missing. */
export function formatCpu(quantity: string | undefined): string {
  if (!quantity) return "—";
  return quantity;
}

const BINARY_SUFFIX: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

/**
 * Format a Kubernetes binary-SI quantity (e.g. "8192Mi", "1048576Ki") or a
 * raw byte count into the largest clean binary unit ("8Gi", "512Mi"). Returns
 * "—" for missing or unparseable input.
 */
export function formatBytes(quantity: string | undefined): string {
  if (!quantity) return "—";
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]+)?$/.exec(quantity.trim());
  if (!m) return "—";
  const value = Number(m[1]);
  if (Number.isNaN(value)) return "—";
  const suffix = m[2];
  let bytes: number;
  if (!suffix) {
    bytes = value;
  } else if (suffix in BINARY_SUFFIX) {
    bytes = value * BINARY_SUFFIX[suffix];
  } else {
    return "—";
  }
  const units = ["Ei", "Pi", "Ti", "Gi", "Mi", "Ki"] as const;
  for (const u of units) {
    const factor = BINARY_SUFFIX[u];
    if (bytes >= factor) {
      const n = bytes / factor;
      // Trim to a clean integer when exact, else one decimal place.
      const rounded = Number.isInteger(n) ? n : Math.round(n * 10) / 10;
      return `${rounded}${u}`;
    }
  }
  return `${bytes}`;
}

/** Raw capacity quantity string for a resource key, or undefined. */
export function capacityValue(node: Node, key: string): string | undefined {
  return node.status?.capacity?.[key];
}

/**
 * Case-insensitive substring match against node name and label keys/values.
 * Empty/blank query matches everything. Mirrors the Pods panel search.
 */
export function matchesSearch(node: Node, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (node.metadata.name.toLowerCase().includes(q)) return true;
  const labels = node.metadata.labels ?? {};
  for (const [k, v] of Object.entries(labels)) {
    if (k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) return true;
  }
  return false;
}

/**
 * Display sort: control-plane nodes first, then by name (lexicographic,
 * case-sensitive). Mirrors `NodesViewModel.sortedNodes`.
 */
export function sortNodes(nodes: Node[]): Node[] {
  return [...nodes].sort((a, b) => {
    const aCp = role(a) === "control-plane";
    const bCp = role(b) === "control-plane";
    if (aCp !== bCp) return aCp ? -1 : 1;
    return a.metadata.name.localeCompare(b.metadata.name);
  });
}
