import Foundation

/// Outcome of a reconciler operation. Carries a human-readable message on failure
/// only — NEVER a Secret body (see the no-logging note in the design spec).
enum ReconcileOutcome: Equatable { case ok, failed(String) }

/// Performs the cluster side effects for registry accounts via kubectl: create the
/// pull Secret, copy it into a target namespace, and union it into that namespace's
/// `default` ServiceAccount `imagePullSecrets`. Reads/writes go through the existing
/// `KubectlClient` + `WorkloadCommander` plumbing.
///
/// SECURITY: `ensureAccess` reads a Secret's JSON (which contains the base64 token)
/// to copy it across namespaces. That payload is handled in memory only and is never
/// returned in a `ReconcileOutcome` or logged.
struct RegistryAccountReconciler {
    let context: String?

    /// Append `adding` to `existing` unless already present. Order preserved so we
    /// never reorder pull secrets another tool put on the SA.
    static func unionImagePullSecrets(existing: [String], adding: String) -> [String] {
        existing.contains(adding) ? existing : existing + [adding]
    }

    /// A JSON merge-patch body that REPLACES `imagePullSecrets` with the full list.
    /// (A merge patch replaces arrays, so callers must pass the complete unioned set.)
    static func saMergePatch(secretNames: [String]) -> String {
        let items = secretNames.map { #"{"name":"\#($0)"}"# }.joined(separator: ",")
        return #"{"imagePullSecrets":[\#(items)]}"#
    }
}
