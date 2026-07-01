// Workload types for the web Workloads panel. Mirrors the Swift
// `Sources/Rigel/Cluster/WorkloadTypes.swift` data models for StatefulSets,
// DaemonSets, Jobs, and CronJobs. Kept local to the web app so the panel does
// not depend on workspace-package linking for a type-only import (same pattern
// as deployments/types.ts and pods/types.ts).

import type { RawContainer } from "@/panels/components/ContainerCards";

/** Shared metadata sub-object for every workload kind. */
export interface WorkloadMeta {
  name: string;
  namespace?: string;
  uid?: string;
  creationTimestamp?: string; // ISO 8601
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

/** Pod template embedded in a workload spec. */
export interface PodTemplateSpec {
  metadata?: { labels?: Record<string, string> };
  spec?: {
    containers?: RawContainer[];
    nodeSelector?: Record<string, string>;
  };
}
export interface LabelSelector {
  matchLabels?: Record<string, string>;
}
export interface UpdateStrategy {
  type?: string;
}

// --- StatefulSet -----------------------------------------------------------

export interface VolumeClaimTemplate {
  metadata?: { name?: string };
  spec?: {
    storageClassName?: string;
    resources?: { requests?: { storage?: string } };
  };
}

export interface StatefulSetSpec {
  replicas?: number;
  serviceName?: string;
  selector?: LabelSelector;
  updateStrategy?: UpdateStrategy;
  template?: PodTemplateSpec;
  volumeClaimTemplates?: VolumeClaimTemplate[];
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

export interface DaemonSetSpec {
  selector?: LabelSelector;
  updateStrategy?: UpdateStrategy;
  template?: PodTemplateSpec;
}

export interface DaemonSetStatus {
  numberReady?: number;
  desiredNumberScheduled?: number;
  numberAvailable?: number;
  updatedNumberScheduled?: number;
}

export interface DaemonSet {
  metadata: WorkloadMeta;
  spec?: DaemonSetSpec;
  status?: DaemonSetStatus;
}

// --- Job -------------------------------------------------------------------

export interface JobCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

export interface JobSpec {
  completions?: number;
  parallelism?: number;
  backoffLimit?: number;
  suspend?: boolean;
  selector?: LabelSelector;
  template?: PodTemplateSpec;
}

export interface JobStatus {
  active?: number;
  succeeded?: number;
  failed?: number;
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

export interface ActiveObjectRef {
  name?: string;
  namespace?: string;
  uid?: string;
}

export interface CronJobSpec {
  schedule?: string;
  suspend?: boolean;
  concurrencyPolicy?: string;
  successfulJobsHistoryLimit?: number;
  failedJobsHistoryLimit?: number;
  jobTemplate?: { spec?: JobSpec };
}

export interface CronJobStatus {
  active?: ActiveObjectRef[];
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

/** Chat-handoff topics offered on each workload row. */
export type WorkloadTopic = "Errors" | "Logs" | "Explain";

/**
 * Signature of the panel's chat-handoff helper, passed down to row components
 * so each row can open the copilot for its resource.
 */
export type AskClaudeFn = (
  kind: string,
  name: string,
  namespace: string | undefined,
  topic: WorkloadTopic,
) => void;
