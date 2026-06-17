// Pure analysis + formatting helpers for the Right-Sizing panel.
//
// Ports the Swift RightSizing engine verbatim (Sources/Helmsman/RightSizing/
// RightSizing.swift + Quantity formatting). No I/O — fully testable.

import type {
  ContainerResources,
  RightSizingResult,
  SortMode,
  Verdict,
  WindowStats,
  WorkloadRightSizing,
} from "./types";

// --- Analysis constants (verbatim from the Swift engine) -------------------

const MiB = 1024 * 1024;

export const MIN_HOURS = 24; // insufficient data below this
const CPU_LIMIT_HEADROOM = 1.5; // limits = peak × this (CPU burst room)
const MEM_LIMIT_HEADROOM = 1.2; // limits = peak × this (OOM cushion)
const AT_RISK_MEM_FRACTION = 0.9; // peak ≥ 90% of mem limit → risk
const AT_RISK_CPU_FRACTION = 0.95; // peak ≥ 95% of cpu limit → throttling
const OVER_MEM_RATIO = 2.0; // request > 2× typical → wasteful
const OVER_CPU_RATIO = 3.0; // request > 3× typical → wasteful
const MIN_MEM_SLACK = 128 * MiB; // ignore < 128 MiB reclaimable
const MIN_CPU_SLACK = 0.1; // ignore < 100m reclaimable (cores)

const MIN_CPU_REQUEST = 0.01; // cores
const MIN_MEM_REQUEST = 1; // byte

// --- Verdict ordering (needs-attention / worst-of) -------------------------

/** Lower = more urgent. Used for "worst" verdict and needs-attention sort. */
const VERDICT_RANK: Record<Verdict, number> = {
  atRisk: 0,
  unset: 1,
  overProvisioned: 2,
  ok: 3,
  insufficientData: 4,
};

/** The more-urgent of two verdicts. */
export function worstVerdict(a: Verdict, b: Verdict): Verdict {
  return VERDICT_RANK[a] <= VERDICT_RANK[b] ? a : b;
}

// --- Analysis engine -------------------------------------------------------

/**
 * Analyze one container's current resources against observed usage.
 * First matching rule wins (insufficient → atRisk → unset → over → ok).
 */
export function analyzeContainer(
  current: ContainerResources,
  stats: WindowStats,
): RightSizingResult {
  const {
    cpuRequest,
    cpuLimit,
    memRequest,
    memLimit,
  } = current;
  const { cpuPeak, cpuTypical, memPeak, memTypical, hoursCovered } = stats;

  const base = {
    container: current.container,
    hoursCovered,
    cpuPeak,
    cpuTypical,
    memPeak,
    memTypical,
    cpuRequest,
    cpuLimit,
    memRequest,
    memLimit,
  };

  // 1. Insufficient data — no suggestion shown.
  if (hoursCovered < MIN_HOURS) {
    return {
      ...base,
      verdict: "insufficientData",
      rationale: `Only ${hoursCovered}h of history (need ${MIN_HOURS}h).`,
    };
  }

  // Suggestions (shared by all remaining verdicts).
  const suggestedCpuRequest = Math.max(cpuTypical, MIN_CPU_REQUEST);
  const suggestedMemRequest = Math.max(memTypical, MIN_MEM_REQUEST);
  const suggestedCpuLimit = Math.max(
    cpuPeak * CPU_LIMIT_HEADROOM,
    cpuRequest ?? suggestedCpuRequest,
  );
  const suggestedMemLimit = Math.max(
    memPeak * MEM_LIMIT_HEADROOM,
    memRequest ?? suggestedMemRequest,
  );
  const suggestions = {
    suggestedCpuRequest,
    suggestedCpuLimit,
    suggestedMemRequest,
    suggestedMemLimit,
  };

  // 2. At risk — peak near a limit.
  const memAtRisk =
    memLimit != null && memLimit > 0 && memPeak >= memLimit * AT_RISK_MEM_FRACTION;
  const cpuAtRisk =
    cpuLimit != null && cpuLimit > 0 && cpuPeak >= cpuLimit * AT_RISK_CPU_FRACTION;
  if (memAtRisk || cpuAtRisk) {
    const rationale = memAtRisk
      ? "Peak memory is within 10% of the limit — OOM risk."
      : "Peak CPU is at the limit — likely throttling.";
    return { ...base, ...suggestions, verdict: "atRisk", rationale };
  }

  // 3. Unset — any request/limit missing.
  if (
    cpuRequest == null ||
    cpuLimit == null ||
    memRequest == null ||
    memLimit == null
  ) {
    return {
      ...base,
      ...suggestions,
      verdict: "unset",
      rationale:
        "Missing requests and/or limits — the scheduler can't bin-pack or protect this container.",
    };
  }

  // 4. Over-provisioned — requests well above real usage.
  const memOver =
    memRequest > memTypical * OVER_MEM_RATIO &&
    memRequest - memTypical > MIN_MEM_SLACK;
  const cpuOver =
    cpuRequest > cpuTypical * OVER_CPU_RATIO &&
    cpuRequest - cpuTypical > MIN_CPU_SLACK;
  if (memOver || cpuOver) {
    return {
      ...base,
      ...suggestions,
      verdict: "overProvisioned",
      rationale:
        "Requests are well above real usage — capacity is being reserved but not used.",
    };
  }

  // 5. OK.
  return {
    ...base,
    ...suggestions,
    verdict: "ok",
    rationale: "Requests and limits track observed usage.",
  };
}

/**
 * Reclaimable memory for one container result: how many bytes of *request*
 * could be given back. Only over-provisioned containers contribute.
 */
export function reclaimableMemBytes(r: RightSizingResult): number {
  if (r.verdict !== "overProvisioned") return 0;
  if (r.memRequest == null || r.suggestedMemRequest == null) return 0;
  return Math.max(0, r.memRequest - r.suggestedMemRequest);
}

/** Roll up per-container results into a workload-level summary. */
export function summarizeWorkload(
  kind: WorkloadRightSizing["kind"],
  name: string,
  namespace: string,
  containers: RightSizingResult[],
): WorkloadRightSizing {
  const worst = containers.reduce<Verdict>(
    (acc, c) => worstVerdict(acc, c.verdict),
    "insufficientData",
  );
  const reclaim = containers.reduce((sum, c) => sum + reclaimableMemBytes(c), 0);
  return { kind, name, namespace, containers, worst, reclaimableMemBytes: reclaim };
}

// --- Quantity parsing (k8s manifest strings → numbers) ---------------------

const BINARY_MEM: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
};
const DECIMAL_MEM: Record<string, number> = {
  k: 1000,
  M: 1000 ** 2,
  G: 1000 ** 3,
  T: 1000 ** 4,
  P: 1000 ** 5,
};

/**
 * Parse a k8s quantity string.
 * - CPU → cores. "1500m" → 1.5, "4" → 4, "250m" → 0.25.
 * - Memory → bytes. "512Mi" → 536870912, "1Gi" → 1073741824.
 */
export function parseQuantity(value: string, type: "cpu" | "memory"): number {
  const v = value.trim();
  if (v === "") return 0;

  if (type === "cpu") {
    if (v.endsWith("m")) {
      const n = Number(v.slice(0, -1));
      return Number.isFinite(n) ? n / 1000 : 0;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  const bi = v.match(/^(\d+(?:\.\d+)?)([KMGTP]i)$/);
  if (bi) return Number(bi[1]) * BINARY_MEM[bi[2]];
  const dec = v.match(/^(\d+(?:\.\d+)?)([kMGTP])$/);
  if (dec) return Number(dec[1]) * DECIMAL_MEM[dec[2]];
  const plain = Number(v);
  return Number.isFinite(plain) ? plain : 0;
}

// --- Display formatting ----------------------------------------------------

/**
 * CPU cores → display string.
 * <1 core → "Xm" (millicores), ≥1 & <10 → 2 decimals, ≥10 → integer.
 */
export function formatCpuCores(cores: number): string {
  if (cores < 1) {
    return `${Math.round(cores * 1000)}m`;
  }
  if (cores < 10) {
    return cores.toFixed(2);
  }
  return String(Math.round(cores));
}

/**
 * Memory bytes → binary-suffix display string. 1 decimal if < 10 units,
 * 0 decimals if ≥ 10 units. "1.5 GiB", "256 MiB".
 */
export function formatMemBytes(bytes: number): string {
  const units: Array<[string, number]> = [
    ["TiB", 1024 ** 4],
    ["GiB", 1024 ** 3],
    ["MiB", 1024 ** 2],
    ["KiB", 1024],
  ];
  for (const [suffix, scale] of units) {
    if (bytes >= scale) {
      const v = bytes / scale;
      return `${v < 10 ? v.toFixed(1) : String(Math.round(v))} ${suffix}`;
    }
  }
  return `${Math.round(bytes)} B`;
}

// --- Quantity generation (numbers → kubectl-valid strings) -----------------

/**
 * CPU cores → kubectl quantity. Round up to the nearest 10m; collapse whole
 * cores. 0.25 → "250m", 2.0 → "2", 0.255 → "260m".
 */
export function cpuToString(cores: number): string {
  const milli = Math.ceil((cores * 1000) / 10) * 10; // round up to 10m
  if (milli > 0 && milli % 1000 === 0) {
    return String(milli / 1000); // whole cores
  }
  return `${milli}m`;
}

/**
 * Memory bytes → kubectl quantity. Round up to the nearest MiB; collapse GiB.
 * 320 MiB → "320Mi", 2 GiB → "2Gi".
 */
export function memToString(bytes: number): string {
  const mib = Math.ceil(bytes / MiB);
  if (mib > 0 && mib % 1024 === 0) {
    return `${mib / 1024}Gi`; // whole GiB
  }
  return `${mib}Mi`;
}

/** Unified entry point matching the spec's `quantityToString`. */
export function quantityToString(value: number, type: "cpu" | "memory"): string {
  return type === "cpu" ? cpuToString(value) : memToString(value);
}

/** Build the kubectl `--requests`/`--limits` value strings for a result. */
export function suggestionQuantities(r: RightSizingResult): {
  requests: string;
  limits: string;
} {
  return {
    requests: `cpu=${cpuToString(r.suggestedCpuRequest ?? 0)},memory=${memToString(
      r.suggestedMemRequest ?? 0,
    )}`,
    limits: `cpu=${cpuToString(r.suggestedCpuLimit ?? 0)},memory=${memToString(
      r.suggestedMemLimit ?? 0,
    )}`,
  };
}

/** Build the YAML resource snippet for the Copy action. */
export function suggestionYaml(r: RightSizingResult): string {
  return [
    "resources:",
    "  requests:",
    `    cpu: ${cpuToString(r.suggestedCpuRequest ?? 0)}`,
    `    memory: ${memToString(r.suggestedMemRequest ?? 0)}`,
    "  limits:",
    `    cpu: ${cpuToString(r.suggestedCpuLimit ?? 0)}`,
    `    memory: ${memToString(r.suggestedMemLimit ?? 0)}`,
  ].join("\n");
}

// --- Sorting ---------------------------------------------------------------

function byNsName(a: WorkloadRightSizing, b: WorkloadRightSizing): number {
  return (
    a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)
  );
}

/**
 * Sort workloads by the chosen mode.
 * - needs-attention: by worst-verdict rank (atRisk→unset→over→ok→insufficient),
 *   then ns/name within each tier.
 * - wasteful: reclaimableMemBytes descending, then ns/name.
 * - name: ns/name alphabetical.
 */
export function sortWorkloads(
  items: WorkloadRightSizing[],
  mode: SortMode,
): WorkloadRightSizing[] {
  const copy = [...items];
  if (mode === "name") {
    return copy.sort(byNsName);
  }
  if (mode === "wasteful") {
    return copy.sort(
      (a, b) => b.reclaimableMemBytes - a.reclaimableMemBytes || byNsName(a, b),
    );
  }
  // needs-attention
  return copy.sort(
    (a, b) => VERDICT_RANK[a.worst] - VERDICT_RANK[b.worst] || byNsName(a, b),
  );
}

/** Case-insensitive substring match on workload name or namespace. */
export function matchesSearch(w: WorkloadRightSizing, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (q === "") return true;
  return (
    w.name.toLowerCase().includes(q) || w.namespace.toLowerCase().includes(q)
  );
}

// --- Verdict display metadata ----------------------------------------------

export interface VerdictStyle {
  label: string;
  /** Tailwind text/bg classes for the badge. */
  className: string;
}

export function verdictStyle(v: Verdict): VerdictStyle {
  switch (v) {
    case "ok":
      return {
        label: "OK",
        className:
          "bg-green-500/15 text-green-600 dark:text-green-400",
      };
    case "overProvisioned":
      return {
        label: "Over-provisioned",
        className: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
      };
    case "atRisk":
      return {
        label: "At risk",
        className: "bg-destructive/15 text-destructive",
      };
    case "unset":
      return {
        label: "Unset",
        className: "bg-destructive/15 text-destructive",
      };
    case "insufficientData":
      return {
        label: "Gathering data",
        className: "bg-muted text-muted-foreground",
      };
  }
}