import Foundation
import Observation

/// Backs the Assistant tab. Reads the agent's state from the watched ConfigMaps
/// (`cache.configMaps`) and drives the guided install/uninstall + kill-switch.
/// Mutations that should be human-confirmed (running a queued suggestion,
/// reverting an action) are routed back through MainWindow's confirm-sheet flow.
struct AssistantLiveIssue: Identifiable {
    let location: String
    let reason: String
    /// Matches the agent's incident fingerprint so it can be silenced.
    let fingerprint: String
    var id: String { fingerprint }
}

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

    /// The agent Deployment, found in whatever namespace it was installed into.
    private var agentDeployment: Deployment? {
        cache.deployments.first { $0.metadata.name == "helmsman-assistant" }
    }

    /// Installed = the agent Deployment exists somewhere in the cluster.
    var isInstalled: Bool { agentDeployment != nil }

    /// Namespace the agent is actually installed in (discovered), so state reads
    /// don't depend on remembering the install choice across launches.
    var installedNamespace: String? { agentDeployment.map { $0.metadata.namespace ?? "default" } }

    /// Where to read the agent's own resources from.
    private var stateNamespace: String { installedNamespace ?? config.installNamespace }

    private func configMap(_ name: String) -> ConfigMap? {
        cache.configMaps.first { $0.metadata.name == name && ($0.metadata.namespace ?? "default") == stateNamespace }
    }

    var clusterState: AssistantClusterState? {
        guard let raw = configMap("assistant-state")?.data?["state.json"],
              let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(AssistantClusterState.self, from: data)
    }

    /// Kill-switch reflects the assistant-config ConfigMap; default on if absent.
    var enabled: Bool { configData["enabled"] != "false" }

    // Live control surface (assistant-config) — read here, written via patchConfig.
    private var configData: [String: String] { configMap("assistant-config")?.data ?? [:] }
    var autonomyMode: String { configData["mode"] ?? "auto" }
    var quietWindow: String { configData["window"] ?? "" }
    var webhookURL: String { configData["webhookUrl"] ?? "" }
    var signalApiUrl: String { configData["signalApiUrl"] ?? "" }
    var signalNumber: String { configData["signalNumber"] ?? "" }
    var signalRecipients: String { configData["signalRecipients"] ?? "" }
    var silencedSet: Set<String> {
        Set((configData["silenced"] ?? "")
            .split(whereSeparator: { $0 == "\n" || $0 == "," })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty })
    }

    /// The pod actually running the agent (by the Deployment's pod label).
    var agentPod: Pod? {
        cache.pods.first {
            ($0.metadata.labels?["app.kubernetes.io/name"]) == "helmsman-assistant"
                && ($0.metadata.namespace ?? "default") == stateNamespace
        }
    }

    /// True when the chosen install namespace doesn't exist yet — drives the
    /// "create it?" confirmation before install.
    var namespaceMissing: Bool {
        let ns = config.installNamespace.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ns.isEmpty else { return false }
        return !cache.namespaces.contains { $0.metadata.name == ns }
    }

    func restartCount(_ pod: Pod) -> Int {
        (pod.status?.containerStatuses ?? []).reduce(0) { $0 + $1.restartCount }
    }

    var status: AssistantAgentStatus? { clusterState?.status }
    var audit: [AssistantAuditEntry] { clusterState?.audit ?? [] }
    var queue: [AssistantQueuedSuggestion] { clusterState?.queue ?? [] }
    var report: String { clusterState?.report ?? "" }

    /// How many audit entries had a given outcome (for the summary strip).
    func auditCount(_ outcome: String) -> Int { audit.filter { $0.outcome == outcome }.count }

    /// What the cluster looks like *right now*, independent of the agent — the
    /// incidents the agent is (or should be) reacting to. Derived from the live
    /// cache so the control center shows current reality next to agent actions.
    var liveIssues: [AssistantLiveIssue] {
        var out: [AssistantLiveIssue] = []
        for p in cache.pods {
            if let reason = p.errorReason {
                let ns = p.metadata.namespace ?? "default"
                out.append(.init(location: "\(ns)/\(p.metadata.name)", reason: reason,
                                 fingerprint: "unhealthyPod|\(ns)|\(p.metadata.name)|\(reason)"))
            }
        }
        for d in cache.deployments {
            let desired = d.spec?.replicas ?? d.status?.replicas ?? 0
            let ready = d.status?.readyReplicas ?? 0
            if desired > 0 && ready < desired {
                let ns = d.metadata.namespace ?? "default"
                out.append(.init(location: "\(ns)/\(d.metadata.name)", reason: "Degraded \(ready)/\(desired)",
                                 fingerprint: "degradedDeployment|\(ns)|\(d.metadata.name)|Degraded"))
            }
        }
        return out
    }

    var manifestPreview: String { AssistantInstaller.manifestYAML(config) }

    /// All namespaces in the cluster, for the install-target and monitor dropdowns.
    var allNamespaceNames: [String] { cache.namespaces.map { $0.metadata.name }.sorted() }

    /// The set of namespaces the agent is scoped to monitor (empty = all).
    var monitoredSet: Set<String> {
        Set(config.namespaces.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
    }

    func toggleMonitored(_ ns: String) {
        var s = monitoredSet
        if s.contains(ns) { s.remove(ns) } else { s.insert(ns) }
        config.namespaces = s.sorted().joined(separator: ",")
    }

    func monitorAllNamespaces() { config.namespaces = "" }

    /// Existing image-pull (dockerconfigjson) Secrets in the agent's namespace,
    /// offered as a dropdown so you can reuse one instead of typing its name.
    var pullSecretCandidates: [Secret] {
        let ns = config.installNamespace
        return cache.secrets
            .filter { $0.secretType == .dockerconfigjson && ($0.metadata.namespace ?? "default") == ns }
            .sorted { $0.metadata.name < $1.metadata.name }
    }

    /// Token expiry, derived from the issued-at annotation the installer stamped
    /// on the token Secret. Nil if the Secret or annotation is missing.
    var tokenExpiry: TokenExpiry.Status? {
        let secret = cache.secrets.first {
            $0.metadata.name == AssistantInstaller.secretName && ($0.metadata.namespace ?? "default") == stateNamespace
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
        token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            actionError = "Paste the token from `claude setup-token` first."
            return
        }
        // Normalize the image: trim stray whitespace, and reject an uppercase
        // repository path — Kubernetes rejects those as InvalidImageName.
        config.image = config.image.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !config.image.isEmpty else {
            actionError = "Set a container image first."
            return
        }
        let repoPath = config.image.split(separator: ":").first.map(String.init) ?? config.image
        if repoPath != repoPath.lowercased() {
            actionError = "Image repository must be lowercase (Kubernetes rejects uppercase as InvalidImageName)."
            return
        }
        // Normalize + validate the install namespace (must be a lowercase DNS label).
        config.installNamespace = config.installNamespace.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !config.installNamespace.isEmpty else {
            actionError = "Set an install namespace (e.g. default)."
            return
        }
        if config.installNamespace != config.installNamespace.lowercased() {
            actionError = "Namespace must be lowercase."
            return
        }
        let ns = config.installNamespace
        working = true
        actionError = nil
        defer { working = false }

        // Create the target namespace if it doesn't exist (apply is idempotent;
        // the panel has already confirmed creation with the user).
        if namespaceMissing {
            if let err = await applyYAML(AssistantInstaller.namespaceYAML(ns)) {
                actionError = "Failed to create namespace \(ns): \(err)"
                return
            }
        }

        // Private-registry pull Secret (only if a name is set AND a token was
        // supplied; a name alone means "use an existing pull Secret").
        if !config.imagePullSecretName.isEmpty,
           !registryToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let registry = String(config.image.split(separator: "/").first ?? "ghcr.io")
            let yaml = AssistantInstaller.dockerConfigSecretYAML(
                name: config.imagePullSecretName, registry: registry,
                username: registryUsername, token: registryToken, namespace: ns
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
        if let err = await applyYAML(AssistantInstaller.secretYAML(token: token, issuedAt: issuedAt, namespace: ns)) {
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
        // Delete from wherever it's actually installed. Leave the namespace
        // itself in place (it may predate or outlive the agent).
        var c = config
        c.installNamespace = installedNamespace ?? config.installNamespace
        if let err = await deleteYAML(AssistantInstaller.manifestYAML(c)) {
            actionError = "Uninstall failed: \(err)"
            return
        }
        _ = await deleteYAML(AssistantInstaller.secretYAML(token: "x", namespace: c.installNamespace))
    }

    /// Replace the agent's OAuth token Secret (trimmed, re-stamping the issued
    /// date) and roll the Deployment so the new pod picks it up. Use this when
    /// the token expired or was pasted wrong (401 Invalid bearer token).
    func updateToken() async {
        token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            actionError = "Paste a fresh token from `claude setup-token` first."
            return
        }
        working = true
        actionError = nil
        defer { working = false }
        let ns = installedNamespace ?? config.installNamespace
        let issuedAt = ISO8601DateFormatter().string(from: Date())
        if let err = await applyYAML(AssistantInstaller.secretYAML(token: token, issuedAt: issuedAt, namespace: ns)) {
            actionError = "Failed to update token: \(err)"
            return
        }
        token = "" // don't keep it in memory
        if let err = await restartRollout(ns) {
            actionError = "Token saved, but rollout failed: \(err)"
        }
    }

    /// Clear the agent's last report (e.g. a stale auth warning). Read-modify-
    /// writes only the `report` field of the state ConfigMap; the agent only
    /// re-populates it on a fresh event, so a cleared report stays cleared.
    func clearReport() async {
        guard let raw = configMap("assistant-state")?.data?["state.json"],
              let data = raw.data(using: .utf8),
              var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }
        obj["report"] = ""
        guard let newData = try? JSONSerialization.data(withJSONObject: obj),
              let newJSON = String(data: newData, encoding: .utf8) else { return }
        let cm: [String: Any] = [
            "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": ["name": "assistant-state", "namespace": stateNamespace,
                         "labels": ["app.kubernetes.io/managed-by": "helmsman-assistant"]],
            "data": ["state.json": newJSON],
        ]
        guard let cmData = try? JSONSerialization.data(withJSONObject: cm),
              let cmJSON = String(data: cmData, encoding: .utf8) else { return }
        working = true
        defer { working = false }
        if let err = await applyYAML(cmJSON) { actionError = "Failed to clear report: \(err)" }
    }

    /// Roll the agent Deployment (new pod) — picks up an updated Secret/config.
    func restartAgent() async {
        working = true
        actionError = nil
        defer { working = false }
        if let err = await restartRollout(installedNamespace ?? config.installNamespace) {
            actionError = "Restart failed: \(err)"
        }
    }

    private func restartRollout(_ ns: String) async -> String? {
        await runKubectl(["rollout", "restart", "deployment/helmsman-assistant", "-n", ns], stdin: nil)
    }

    /// Flip the kill-switch. Instant by design — the emergency stop.
    func setEnabled(_ on: Bool) async { await patchConfig(["enabled": on ? "true" : "false"]) }

    /// Set autonomy mode (auto | advisory | window) and the quiet-hours window.
    func setMode(_ mode: String, window: String) async {
        await patchConfig(["mode": mode, "window": window.trimmingCharacters(in: .whitespacesAndNewlines)])
    }

    /// Set the outbound notification webhook (Slack/Discord/ntfy). Empty clears it.
    func setWebhook(_ url: String) async { await patchConfig(["webhookUrl": url.trimmingCharacters(in: .whitespacesAndNewlines)]) }

    /// Configure the self-hosted Signal bridge (signal-cli-rest-api).
    func setSignal(apiUrl: String, number: String, recipients: String) async {
        await patchConfig([
            "signalApiUrl": apiUrl.trimmingCharacters(in: .whitespacesAndNewlines),
            "signalNumber": number.trimmingCharacters(in: .whitespacesAndNewlines),
            "signalRecipients": recipients.trimmingCharacters(in: .whitespacesAndNewlines),
        ])
    }

    func silence(_ fingerprint: String) async {
        var s = silencedSet; s.insert(fingerprint)
        await patchConfig(["silenced": s.sorted().joined(separator: "\n")])
    }

    func unsilence(_ fingerprint: String) async {
        var s = silencedSet; s.remove(fingerprint)
        await patchConfig(["silenced": s.sorted().joined(separator: "\n")])
    }

    /// Read-modify-write assistant-config, merging `updates` over existing keys so
    /// changing one setting never clobbers the others (kill-switch, mode, silence…).
    private func patchConfig(_ updates: [String: String]) async {
        working = true
        defer { working = false }
        var data = configData
        for (k, v) in updates { data[k] = v }
        let cm: [String: Any] = [
            "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": ["name": "assistant-config", "namespace": stateNamespace,
                         "labels": ["app.kubernetes.io/managed-by": "helmsman-assistant"]],
            "data": data,
        ]
        guard let cmData = try? JSONSerialization.data(withJSONObject: cm),
              let cmJSON = String(data: cmData, encoding: .utf8) else { return }
        if let err = await applyYAML(cmJSON) { actionError = "Failed to update config: \(err)" }
    }

    // MARK: - kubectl plumbing

    private func applyYAML(_ yaml: String) async -> String? { await runKubectl(["apply", "-f", "-"], stdin: yaml) }
    private func deleteYAML(_ yaml: String) async -> String? {
        await runKubectl(["delete", "-f", "-", "--ignore-not-found=true"], stdin: yaml)
    }

    /// Apply arbitrary YAML through the agent's kubectl/context plumbing.
    /// Returns nil on success, or an error string.
    func applyManifest(_ yaml: String) async -> String? {
        await applyYAML(yaml)
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
