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

// ---------------------------------------------------------------------------
// Numeric quantity parsing + formatting for the per-node usage bars.
// Mirrors Swift `ResourceQuantity` (cpuCores / bytes / formatCores / formatBytes)
// so the web NodeCard renders identical values.
// ---------------------------------------------------------------------------

/** Parse a CPU quantity into cores. "500m"→0.5, "1500000n"→0.0015, "4"→4. */
export function parseCpuCores(value: string | undefined): number {
  if (!value) return 0;
  const s = value.trim();
  if (s === "") return 0;
  if (s.endsWith("m")) return (Number(s.slice(0, -1)) || 0) / 1_000;
  if (s.endsWith("u")) return (Number(s.slice(0, -1)) || 0) / 1_000_000;
  if (s.endsWith("n")) return (Number(s.slice(0, -1)) || 0) / 1_000_000_000;
  return Number(s) || 0;
}

const DECIMAL_SUFFIX: Record<string, number> = {
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

/** Parse a memory quantity into bytes. Binary (Ki/Mi/Gi…) + decimal (K/M/G…). */
export function parseBytes(value: string | undefined): number {
  if (!value) return 0;
  const s = value.trim();
  if (s === "") return 0;
  for (const [suf, mult] of Object.entries(BINARY_SUFFIX)) {
    if (s.endsWith(suf)) return (Number(s.slice(0, -suf.length)) || 0) * mult;
  }
  for (const [suf, mult] of Object.entries(DECIMAL_SUFFIX)) {
    if (s.endsWith(suf)) return (Number(s.slice(0, -1)) || 0) * mult;
  }
  return Number(s) || 0;
}

/** Format cores: <1 → "908 m"; <10 → "1.49"; else "12". (Swift formatCores.) */
export function formatCoresValue(cores: number): string {
  if (cores < 1) return `${Math.round(cores * 1000)} m`;
  return cores >= 10 ? `${Math.round(cores)}` : cores.toFixed(2);
}

/** Format bytes into GiB/MiB/… with a space: "9.8 GiB", "441 GiB". (Swift formatBytes.) */
export function formatBytesValue(b: number): string {
  const units: Array<[number, string]> = [
    [BINARY_SUFFIX.Ti, "TiB"],
    [BINARY_SUFFIX.Gi, "GiB"],
    [BINARY_SUFFIX.Mi, "MiB"],
    [BINARY_SUFFIX.Ki, "KiB"],
  ];
  for (const [size, label] of units) {
    if (b >= size) {
      const v = b / size;
      return v >= 10 ? `${Math.round(v)} ${label}` : `${(Math.round(v * 10) / 10).toFixed(1)} ${label}`;
    }
  }
  return `${Math.round(b)} B`;
}

/** Usage-bar color by fraction: <0.7 green, <0.9 amber, else red; grey when no data. */
export function usageColor(percent: number, hasMetrics: boolean): string {
  if (!hasMetrics) return "#2A2A2A";
  if (percent < 0.7) return "#10B981";
  if (percent < 0.9) return "#F59E0B";
  return "#EF4444";
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
