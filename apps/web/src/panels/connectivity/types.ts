// Types for the web Connectivity panel. Mirrors the Swift `Connectivity` enum
// in `Sources/Rigel/Cluster/Connectivity.swift` and the normative spec in
// `docs/parity/connectivity.md`.
//
// Connectivity reuses the existing resource types from the Ingresses, Services,
// and Pods panels — it does not redefine them. A `Flow` is a derived row, not a
// stored resource.

export type Health = "ok" | "warn" | "broken";

/**
 * A derived request path: ingress hosts → ingress objects → service → backing
 * pods (or just service → pods for internal services). Mirrors the Swift
 * `Connectivity.Flow` struct. `health` is derived, not stored.
 */
export interface Flow {
  /** "namespace/service-name" — unique key. */
  id: string;
  /** Ingress hosts routing here (sorted); empty = internal. */
  hosts: string[];
  /** Ingress object names fronting this service (sorted). */
  ingressNames: string[];
  serviceName: string;
  namespace: string;
  /** "ClusterIP" etc; "—" when the service is missing. */
  serviceType: string;
  serviceExists: boolean;
  /** Pods matching the selector that are Running with all containers ready. */
  readyPods: number;
  /** All pods matching the selector (running or not). */
  totalPods: number;
  /** Matching pod names (sorted). */
  podNames: string[];
  /** True iff any Ingress routes to this service. */
  isExternal: boolean;
  /** Reachability warnings; empty = healthy. */
  issues: string[];
  /** Derived: external + issues → broken; internal + issues → warn; else ok. */
  health: Health;
}
