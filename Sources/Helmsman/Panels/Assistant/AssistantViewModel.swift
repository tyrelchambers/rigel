import Foundation
import Observation

/// Backs the Assistant tab. Reads the agent's state from the watched ConfigMaps
/// (`cache.configMaps`) and drives the guided install/uninstall + kill-switch.
/// Mutations that should be human-confirmed (running a queued suggestion,
/// reverting an action) are routed back through MainWindow's confirm-sheet flow.
@MainActor
@Observable
final class AssistantViewModel {
    let cache: ClusterCache
    private var context: String?

    // Installer wizard state.
    var config = AssistantInstallConfig.default
    var token: String = ""
    /// Optional private-registry creds. If a pull-secret name is set and a token
    /// is provided, the installer creates the dockerconfigjson Secret; if only a
    /// name is set, it references an existing pull Secret.
    var registryUsername: String = ""
    var registryToken: String = ""
    var working = false
    var actionError: String?

    init(cache: ClusterCache) { self.cache = cache }

    func load(context: String?) { self.context = context }

    // MARK: - Derived state (from the watched ConfigMaps / Deployment)

    private func configMap(_ name: String) -> ConfigMap? {
        cache.configMaps.first { $0.metadata.name == name && ($0.metadata.namespace ?? "default") == "default" }
    }

    /// Installed = the agent Deployment exists in-cluster.
    var isInstalled: Bool {
        cache.deployments.contains {
            $0.metadata.name == "helmsman-assistant" && ($0.metadata.namespace ?? "default") == "default"
        }
    }

    var clusterState: AssistantClusterState? {
        guard let raw = configMap("assistant-state")?.data?["state.json"],
              let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(AssistantClusterState.self, from: data)
    }

    /// Kill-switch reflects the assistant-config ConfigMap; default on if absent.
    var enabled: Bool { configMap("assistant-config")?.data?["enabled"] != "false" }

    var status: AssistantAgentStatus? { clusterState?.status }
    var audit: [AssistantAuditEntry] { clusterState?.audit ?? [] }
    var queue: [AssistantQueuedSuggestion] { clusterState?.queue ?? [] }
    var report: String { clusterState?.report ?? "" }

    var manifestPreview: String { AssistantInstaller.manifestYAML(config) }

    /// Token expiry, derived from the issued-at annotation the installer stamped
    /// on the token Secret. Nil if the Secret or annotation is missing.
    var tokenExpiry: TokenExpiry.Status? {
        let secret = cache.secrets.first {
            $0.metadata.name == AssistantInstaller.secretName && ($0.metadata.namespace ?? "default") == "default"
        }
        guard let iso = secret?.metadata.annotations?[TokenExpiry.issuedAtAnnotation], !iso.isEmpty,
              let issued = ISO8601DateFormatter().date(from: iso) else { return nil }
        return TokenExpiry.status(issuedAt: issued, now: Date())
    }

    func backupYAML(ref: String) -> String? {
        configMap("assistant-backups")?.data?[ref]
    }

    // MARK: - Install / uninstall (the wizard's Install button is the gate)

    func install() async {
        guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            actionError = "Paste the token from `claude setup-token` first."
            return
        }
        working = true
        actionError = nil
        defer { working = false }

        // Private-registry pull Secret (only if a name is set AND a token was
        // supplied; a name alone means "use an existing pull Secret").
        if !config.imagePullSecretName.isEmpty,
           !registryToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let registry = String(config.image.split(separator: "/").first ?? "ghcr.io")
            let yaml = AssistantInstaller.dockerConfigSecretYAML(
                name: config.imagePullSecretName, registry: registry,
                username: registryUsername, token: registryToken
            )
            if let err = await applyYAML(yaml) {
                actionError = "Failed to create pull Secret: \(err)"
                return
            }
            registryToken = ""
        }

        // Secret first (carries the OAuth token), then the rest of the manifests.
        // Stamp the mint date so we can warn before the 1-year token expires.
        let issuedAt = ISO8601DateFormatter().string(from: Date())
        if let err = await applyYAML(AssistantInstaller.secretYAML(token: token, issuedAt: issuedAt)) {
            actionError = "Failed to create token Secret: \(err)"
            return
        }
        if let err = await applyYAML(AssistantInstaller.manifestYAML(config)) {
            actionError = "Failed to apply manifests: \(err)"
            return
        }
        token = "" // don't keep it in memory longer than needed
    }

    func uninstall() async {
        working = true
        actionError = nil
        defer { working = false }
        // Delete the workload + RBAC + token; leave state/backups ConfigMaps so a
        // reinstall can show history. (User can delete those manually if desired.)
        if let err = await deleteYAML(AssistantInstaller.manifestYAML(config)) {
            actionError = "Uninstall failed: \(err)"
            return
        }
        _ = await deleteYAML(AssistantInstaller.secretYAML(token: "x"))
    }

    /// Flip the kill-switch by writing the assistant-config ConfigMap. Instant by
    /// design — this is the emergency stop.
    func setEnabled(_ on: Bool) async {
        working = true
        defer { working = false }
        let yaml = """
        apiVersion: v1
        kind: ConfigMap
        metadata:
          name: assistant-config
          namespace: default
          labels:
            app.kubernetes.io/managed-by: helmsman-assistant
        data:
          enabled: "\(on ? "true" : "false")"
        """
        if let err = await applyYAML(yaml) {
            actionError = "Failed to toggle: \(err)"
        }
    }

    // MARK: - kubectl plumbing

    private func applyYAML(_ yaml: String) async -> String? { await runKubectl(["apply", "-f", "-"], stdin: yaml) }
    private func deleteYAML(_ yaml: String) async -> String? {
        await runKubectl(["delete", "-f", "-", "--ignore-not-found=true"], stdin: yaml)
    }

    /// Returns nil on success, or an error string.
    private func runKubectl(_ args: [String], stdin: String?) async -> String? {
        guard let kubectl = resolveBinary("kubectl") else { return "kubectl not found on PATH" }
        var full: [String] = []
        if let context { full.append(contentsOf: ["--context", context]) }
        full.append(contentsOf: args)
        do {
            _ = try await runProcess(kubectl, args: full, stdin: stdin.map { Data($0.utf8) })
            return nil
        } catch ProcessError.nonZeroExit(let code, let stderr) {
            return "exit \(code): \(stderr)"
        } catch {
            return "\(error)"
        }
    }
}
