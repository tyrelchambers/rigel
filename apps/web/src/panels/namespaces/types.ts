// Namespace type for the web Namespaces panel. Mirrors the shared contract in
// `packages/k8s/src/index.ts` and the Swift `Namespace` in
// `Sources/Rigel/Cluster/KubeTypes.swift`. Kept local to the web app so the
// panel does not depend on workspace-package linking for a type-only import.
//
// Namespaces are CLUSTER-SCOPED: no per-namespace qualifier, never filtered by
// the global namespaceFilter.

export interface Namespace {
  metadata: {
    name: string;
    uid: string;
    creationTimestamp?: string; // ISO 8601
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  status?: {
    phase?: string; // "Active" | "Terminating" | ... (defaults to "Active")
  };
}
