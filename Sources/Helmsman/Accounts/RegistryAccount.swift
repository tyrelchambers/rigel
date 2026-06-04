import Foundation

/// A registry/pull-credential account the user manages in Helmsman. Persisted
/// per kube-context in `SessionStore` — METADATA ONLY. The credential never lives
/// on disk: for `managed` accounts it's in the cluster `dockerconfigjson` Secret
/// Helmsman created; for referenced accounts (`managed == false`) Helmsman never
/// sees it. The model is shaped to extend to other account types later.
struct RegistryAccount: Codable, Hashable, Identifiable, Sendable {
    let id: UUID
    var registry: String         // "docker.io", "ghcr.io", "quay.io", or a custom host
    var username: String
    var secretName: String       // k8s Secret name, e.g. "helmsman-dockerhub"
    var sourceNamespace: String  // namespace the Secret lives in (default "default")
    var managed: Bool            // true = Helmsman created the Secret; false = referenced existing
    var isDefault: Bool          // the account auto-attached to installs (≤1 true per context)
}
