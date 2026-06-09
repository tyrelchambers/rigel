// Workload types for the web Workloads panel. Mirrors the Swift
// `Sources/Helmsman/Cluster/WorkloadTypes.swift` data models for StatefulSets,
// DaemonSets, Jobs, and CronJobs. Kept local to the web app so the panel does
// not depend on workspace-package linking for a type-only import (same pattern
// as deployments/types.ts and pods/types.ts).

/** Shared metadata sub-object for every workload kind. */
export interface WorkloadMeta {
  name: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string; // ISO 8601
  labels?: Record<string, string>;
}

// --- StatefulSet -----------------------------------------------------------

export interface StatefulSetSpec {
  replicas?: number;
}

export interface StatefulSetStatus {
  replicas?: number;
  readyReplicas?: number;
}

export interface StatefulSet {
  metadata: WorkloadMeta;
  spec?: StatefulSetSpec;
  status?: StatefulSetStatus;
}

// --- DaemonSet -------------------------------------------------------------

export interface DaemonSetStatus {
  numberReady?: number;
  desiredNumberScheduled?: number;
}

export interface DaemonSet {
  metadata: WorkloadMeta;
  spec?: Record<string, unknown>;
  status?: DaemonSetStatus;
}

// --- Job -------------------------------------------------------------------

export interface JobCondition {
  type?: string;
  status?: string;
}

export interface JobSpec {
  completions?: number;
  suspend?: boolean;
}

export interface JobStatus {
  active?: number;
  succeeded?: number;
  startTime?: string; // ISO 8601
  completionTime?: string; // ISO 8601
  conditions?: JobCondition[];
}

export interface Job {
  metadata: WorkloadMeta;
  spec?: JobSpec;
  status?: JobStatus;
}

// --- CronJob ---------------------------------------------------------------

export interface CronJobSpec {
  schedule?: string;
  suspend?: boolean;
}

export interface CronJobStatus {
  /** References to currently-running jobs. */
  active?: unknown[];
  lastScheduleTime?: string; // ISO 8601
}

export interface CronJob {
  metadata: WorkloadMeta;
  spec?: CronJobSpec;
  status?: CronJobStatus;
}

/** Union of every workload kind (for the shared sort comparator). */
export type Workload = StatefulSet | DaemonSet | Job | CronJob;

/** The four resource kinds shown in the toggle bar. */
export type WorkloadKind = "statefulsets" | "daemonsets" | "jobs" | "cronjobs";
