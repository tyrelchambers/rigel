// Right-Sizing types for the web panel. Mirrors the Swift RightSizing data
// models (Sources/Helmsman/RightSizing/*). Kept local to the web app, same
// pattern as deployments/types.ts.

export type Verdict =
  | "ok"
  | "overProvisioned"
  | "atRisk"
  | "unset"
  | "insufficientData";

/** Parsed container resource spec. Values in cores (CPU) and bytes (memory). */
export interface ContainerResources {
  container: string;
  cpuRequest?: number; // cores
  cpuLimit?: number; // cores
  memRequest?: number; // bytes
  memLimit?: number; // bytes
}

/** Aggregated historical usage over the rolling window. */
export interface WindowStats {
  container: string;
  cpuPeak: number; // cores
  cpuTypical: number; // cores
  memPeak: number; // bytes
  memTypical: number; // bytes
  hoursCovered: number;
}

/** Result of analyzing one container against its usage stats. */
export interface RightSizingResult {
  container: string;
  verdict: Verdict;
  hoursCovered: number;
  cpuPeak: number;
  cpuTypical: number;
  memPeak: number;
  memTypical: number;
  cpuRequest?: number;
  cpuLimit?: number;
  memRequest?: number;
  memLimit?: number;
  suggestedCpuRequest?: number;
  suggestedCpuLimit?: number;
  suggestedMemRequest?: number;
  suggestedMemLimit?: number;
  rationale: string;
}

export type WorkloadKind = "deployment" | "statefulset" | "daemonset";

/** A workload with per-container right-sizing verdicts. */
export interface WorkloadRightSizing {
  kind: WorkloadKind;
  name: string;
  namespace: string;
  containers: RightSizingResult[];
  worst: Verdict; // most urgent verdict across containers
  reclaimableMemBytes: number;
}

export type SortMode = "needs-attention" | "wasteful" | "name";
