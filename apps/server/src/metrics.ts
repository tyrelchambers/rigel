/**
 * Metrics collection + parsing for the Right-Sizing panel.
 *
 * Runs `kubectl top pods|nodes --no-headers` and parses the columnar output
 * into normalized rows. When metrics-server is absent (kubectl top exits
 * non-zero), the public helpers degrade gracefully to
 * `{ available: false, items: [] }` (HTTP 200, never 500).
 *
 * Mirrors the Swift `MetricsServerClient` parsing of `kubectl top` output.
 */

import { kubectl } from "@rigel/k8s/src/run";

export interface PodMetricRow {
  namespace: string;
  name: string;
  /** Millicores as a numeric string (e.g. "150"). */
  cpu: string;
  /** Mebibytes as a quantity string (e.g. "32Mi"). */
  memory: string;
}

export interface NodeMetricRow {
  name: string;
  /** Millicores as a numeric string. */
  cpu: string;
  /** Mebibytes as a quantity string (e.g. "4096Mi"). */
  memory: string;
}

export interface NodeDiskRow {
  name: string;
  /** Root filesystem total / used / available, in bytes. */
  capacityBytes: number;
  usedBytes: number;
  availableBytes: number;
}

export interface MetricsResult<T> {
  available: boolean;
  items: T[];
}

/**
 * Normalize a kubectl-top CPU/memory quantity to a number.
 *
 * - CPU → millicores. "150m" → 150, "1" → 1000, "1500m" → 1500, "0" → 0.
 * - Memory → bytes. "32Mi" → 33554432, "1Gi" → 1073741824, "512Ki" → 524288,
 *   "0" → 0. Accepts both binary (Ki/Mi/Gi/Ti) and (rare) decimal (k/M/G/T)
 *   suffixes that `kubectl top` may emit.
 */
export function normalizeQuantity(value: string, unit: "cpu" | "memory"): number {
  const v = value.trim();
  if (v === "" || v === "<unknown>") return 0;

  if (unit === "cpu") {
    if (v.endsWith("m")) {
      const n = Number(v.slice(0, -1));
      return Number.isFinite(n) ? n : 0;
    }
    if (v.endsWith("n")) {
      // nanocores (some clusters report CPU in n) → millicores
      const n = Number(v.slice(0, -1));
      return Number.isFinite(n) ? n / 1_000_000 : 0;
    }
    if (v.endsWith("u")) {
      // microcores → millicores
      const n = Number(v.slice(0, -1));
      return Number.isFinite(n) ? n / 1_000 : 0;
    }
    // whole cores
    const n = Number(v);
    return Number.isFinite(n) ? n * 1000 : 0;
  }

  // memory → bytes
  const binary: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
  };
  const decimal: Record<string, number> = {
    k: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5,
  };
  const biMatch = v.match(/^(\d+(?:\.\d+)?)([KMGTP]i)$/);
  if (biMatch) {
    return Number(biMatch[1]) * binary[biMatch[2]];
  }
  const decMatch = v.match(/^(\d+(?:\.\d+)?)([kMGTP])$/);
  if (decMatch) {
    return Number(decMatch[1]) * decimal[decMatch[2]];
  }
  const plain = Number(v);
  return Number.isFinite(plain) ? plain : 0;
}

/** Bytes → a "<n>Mi" quantity string (rounded to the nearest mebibyte). */
function bytesToMi(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}Mi`;
}

/**
 * Parse one line of `kubectl top pods --all-namespaces --no-headers`.
 *
 * With `--all-namespaces` the columns are: NAMESPACE NAME CPU MEMORY.
 * Without it (single-namespace): NAME CPU MEMORY (namespace defaulted by caller
 * via the `defaultNamespace` arg). Returns `null` for blank/malformed lines.
 */
export function parseKubectlTopLine(
  line: string,
  defaultNamespace?: string,
): PodMetricRow | null {
  const cols = line.trim().split(/\s+/).filter((c) => c !== "");
  if (cols.length === 4) {
    const [namespace, name, cpu, memory] = cols;
    return {
      namespace,
      name,
      cpu: String(normalizeQuantity(cpu, "cpu")),
      memory: bytesToMi(normalizeQuantity(memory, "memory")),
    };
  }
  if (cols.length === 3 && defaultNamespace) {
    const [name, cpu, memory] = cols;
    return {
      namespace: defaultNamespace,
      name,
      cpu: String(normalizeQuantity(cpu, "cpu")),
      memory: bytesToMi(normalizeQuantity(memory, "memory")),
    };
  }
  return null;
}

/** Parse one line of `kubectl top nodes --no-headers`: NAME CPU CPU% MEM MEM%. */
export function parseKubectlTopNodeLine(line: string): NodeMetricRow | null {
  const cols = line.trim().split(/\s+/).filter((c) => c !== "");
  // NAME  CPU(cores)  CPU%  MEMORY(bytes)  MEMORY%
  if (cols.length < 4) return null;
  const name = cols[0];
  const cpu = cols[1];
  // memory is the column before the trailing percentage; with 5 columns it's [3]
  const memory = cols.length >= 5 ? cols[3] : cols[2];
  return {
    name,
    cpu: String(normalizeQuantity(cpu, "cpu")),
    memory: bytesToMi(normalizeQuantity(memory, "memory")),
  };
}

/** Parse full `kubectl top pods` stdout into rows. */
export function parseKubectlTopPods(
  stdout: string,
  defaultNamespace?: string,
): PodMetricRow[] {
  return stdout
    .split("\n")
    .map((l) => parseKubectlTopLine(l, defaultNamespace))
    .filter((r): r is PodMetricRow => r !== null);
}

/** Parse full `kubectl top nodes` stdout into rows. */
export function parseKubectlTopNodes(stdout: string): NodeMetricRow[] {
  return stdout
    .split("\n")
    .map((l) => parseKubectlTopNodeLine(l))
    .filter((r): r is NodeMetricRow => r !== null);
}

/**
 * Run `kubectl top pods` for a namespace (or all). Returns gracefully when
 * metrics-server is unavailable — never throws, never 500.
 *
 * @param namespace  `"*"` (or undefined) → all namespaces; otherwise a single ns.
 */
export async function getPodMetrics(
  context: string | null,
  namespace: string | undefined,
): Promise<MetricsResult<PodMetricRow>> {
  const all = !namespace || namespace === "*";
  const nsArgs = all ? ["--all-namespaces"] : ["-n", namespace];
  try {
    const res = await kubectl(context, ["top", "pods", ...nsArgs, "--no-headers"]);
    if (res.code !== 0) {
      console.warn(`[metrics] kubectl top pods unavailable: ${res.stderr.trim()}`);
      return { available: false, items: [] };
    }
    return {
      available: true,
      items: parseKubectlTopPods(res.stdout, all ? undefined : namespace),
    };
  } catch (err) {
    console.warn(`[metrics] kubectl top pods failed: ${String(err)}`);
    return { available: false, items: [] };
  }
}

/**
 * Run `kubectl top nodes`. Returns gracefully when metrics-server is
 * unavailable — never throws, never 500.
 */
export async function getNodeMetrics(
  context: string | null,
): Promise<MetricsResult<NodeMetricRow>> {
  try {
    const res = await kubectl(context, ["top", "nodes", "--no-headers"]);
    if (res.code !== 0) {
      console.warn(`[metrics] kubectl top nodes unavailable: ${res.stderr.trim()}`);
      return { available: false, items: [] };
    }
    return { available: true, items: parseKubectlTopNodes(res.stdout) };
  } catch (err) {
    console.warn(`[metrics] kubectl top nodes failed: ${String(err)}`);
    return { available: false, items: [] };
  }
}

/**
 * Per-node root-filesystem usage from the kubelet Summary API
 * (`/api/v1/nodes/<name>/proxy/stats/summary` → `node.fs`). One node whose
 * kubelet proxy is blocked is simply omitted (not a hard failure), so the panel
 * can still show disk capacity from `ephemeral-storage`. Never throws / 500s.
 */
export async function getNodeDisk(
  context: string | null,
): Promise<MetricsResult<NodeDiskRow>> {
  try {
    const list = await kubectl(context, [
      "get",
      "nodes",
      "-o",
      "jsonpath={.items[*].metadata.name}",
    ]);
    if (list.code !== 0) {
      console.warn(`[metrics] node list for disk failed: ${list.stderr.trim()}`);
      return { available: false, items: [] };
    }
    const names = list.stdout.trim().split(/\s+/).filter((n) => n !== "");
    const rows = await Promise.all(
      names.map(async (name): Promise<NodeDiskRow | null> => {
        try {
          const res = await kubectl(context, [
            "get",
            "--raw",
            `/api/v1/nodes/${name}/proxy/stats/summary`,
          ]);
          if (res.code !== 0) return null;
          const summary = JSON.parse(res.stdout) as {
            node?: { fs?: { capacityBytes?: number; usedBytes?: number; availableBytes?: number } };
          };
          const fs = summary.node?.fs;
          if (!fs || fs.capacityBytes == null || fs.usedBytes == null) return null;
          return {
            name,
            capacityBytes: fs.capacityBytes,
            usedBytes: fs.usedBytes,
            availableBytes: fs.availableBytes ?? Math.max(0, fs.capacityBytes - fs.usedBytes),
          };
        } catch {
          return null;
        }
      }),
    );
    const items = rows.filter((r): r is NodeDiskRow => r !== null);
    return { available: items.length > 0, items };
  } catch (err) {
    console.warn(`[metrics] node disk failed: ${String(err)}`);
    return { available: false, items: [] };
  }
}
