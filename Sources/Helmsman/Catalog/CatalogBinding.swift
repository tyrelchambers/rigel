import Foundation

/// Annotation keys that bind a running workload to a catalog app. These are a
/// SHARED CONTRACT with the web app (`packages/catalog`) — identical key
/// strings in both apps. The binding lives in the cluster (on the workload's
/// `metadata.annotations`), travels with the resource, and is honored by every
/// Helmsman client. See `docs/parity/catalog-link-workload.md` §2.1.

/// Value = the catalog app `id` (slug). The workload backs this app, definitively,
/// regardless of image match.
let CATALOG_APP_ANNOTATION = "helmsman.dev/catalog-app"

/// Value = the container name `setImage` should target on a multi-container
/// workload. Optional; omitted on single-container workloads.
let CATALOG_CONTAINER_ANNOTATION = "helmsman.dev/catalog-container"

/// The catalog app id a controller is explicitly bound to, or nil. The ONLY
/// reader of `CATALOG_APP_ANNOTATION` — detection/update functions go through
/// here so the key string appears in exactly one place.
func boundAppID(_ meta: ObjectMeta?) -> String? {
    guard let value = meta?.annotations?[CATALOG_APP_ANNOTATION], !value.isEmpty else { return nil }
    return value
}

/// The bound container name, or nil. The ONLY reader of
/// `CATALOG_CONTAINER_ANNOTATION`.
func boundContainer(_ meta: ObjectMeta?) -> String? {
    guard let value = meta?.annotations?[CATALOG_CONTAINER_ANNOTATION], !value.isEmpty else { return nil }
    return value
}

/// A workload an app is explicitly bound to via `helmsman.dev/catalog-app`.
/// Used by the detail sheet (to show bound kind/name + container with an
/// Unlink button) and to build the unlink action. The bound workload is found
/// deterministically in scan order (deployments → statefulSets → daemonSets),
/// matching `updateTargets`.
struct WorkloadBinding: Equatable {
    /// "deployment" | "statefulset" | "daemonset" — a kubectl resource string.
    let kind: String
    let name: String
    let namespace: String
    /// The pinned container (`catalog-container`), or nil when unset.
    let container: String?

    /// The first workload (in scan order) bound to `appID`, or nil.
    static func find(
        appID: String,
        deployments: [Deployment],
        statefulSets: [StatefulSet],
        daemonSets: [DaemonSet]
    ) -> WorkloadBinding? {
        for d in deployments where boundAppID(d.metadata) == appID {
            return WorkloadBinding(kind: "deployment", name: d.metadata.name,
                                   namespace: d.metadata.namespace ?? "default", container: boundContainer(d.metadata))
        }
        for s in statefulSets where boundAppID(s.metadata) == appID {
            return WorkloadBinding(kind: "statefulset", name: s.metadata.name,
                                   namespace: s.metadata.namespace ?? "default", container: boundContainer(s.metadata))
        }
        for ds in daemonSets where boundAppID(ds.metadata) == appID {
            return WorkloadBinding(kind: "daemonset", name: ds.metadata.name,
                                   namespace: ds.metadata.namespace ?? "default", container: boundContainer(ds.metadata))
        }
        return nil
    }
}
