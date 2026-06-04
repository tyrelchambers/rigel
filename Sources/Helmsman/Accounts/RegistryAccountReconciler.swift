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

    /// Run a read-only kubectl command, returning (stdout, ok). Mirrors the
    /// `runKubectl` pattern in MainWindow. The caller must treat stdout as
    /// potentially secret and never log it.
    private func read(_ args: [String]) async -> (out: String, ok: Bool) {
        guard let ctx = context else { return ("", false) }
        guard let kubectl = resolveBinary("kubectl") else { return ("kubectl not found on PATH", false) }
        do {
            let data = try await runProcess(kubectl, args: ["--context", ctx] + args)
            return (String(decoding: data, as: UTF8.self), true)
        } catch ProcessError.nonZeroExit(_, let stderr) {
            return (stderr, false)
        } catch {
            return ("\(error)", false)
        }
    }

    /// Build the dockerconfigjson Secret from credentials and apply it to
    /// `namespace`. Returns `.ok` on success; the token is not retained after this.
    func create(registry: String, username: String, token: String,
                secretName: String, namespace: String) async -> ReconcileOutcome {
        let json = RegistryCredentialBuilder.dockerConfigJSON(registry: registry, username: username, token: token)
        let secret = Secret.draft(
            name: secretName,
            namespace: namespace,
            type: .dockerconfigjson,
            decodedData: [".dockerconfigjson": json],
            labels: ["app.kubernetes.io/managed-by": "helmsman"]
        )
        let result = await WorkloadCommander(context: context).run(.applySecret(secret))
        return result.ok ? .ok : .failed(result.stderr.isEmpty ? "kubectl exited \(result.exitCode)" : result.stderr)
    }

    /// Confirm a referenced Secret exists (used by the "reference existing" path).
    func verifyReference(secretName: String, namespace: String) async -> ReconcileOutcome {
        let (out, ok) = await read(["get", "secret", secretName, "-n", namespace, "-o", "name"])
        if ok { return .ok }
        return .failed(out.isEmpty ? "secret \(secretName) not found in \(namespace)" : out)
    }

    /// Ensure `account`'s Secret exists in `namespace`, then union it into that
    /// namespace's `default` ServiceAccount imagePullSecrets. Idempotent.
    func ensureAccess(account: RegistryAccount, namespace: String) async -> ReconcileOutcome {
        // 1. Ensure the Secret is present in the target namespace.
        if namespace != account.sourceNamespace {
            // Read the source Secret's JSON (contains the base64 token) — kept in
            // memory only, never logged.
            let (json, ok) = await read(["get", "secret", account.secretName, "-n", account.sourceNamespace, "-o", "json"])
            guard ok else { return .failed("couldn't read \(account.secretName) in \(account.sourceNamespace)") }
            guard let src = try? JSONDecoder().decode(Secret.self, from: Data(json.utf8)) else {
                return .failed("couldn't parse \(account.secretName)")
            }
            let copy = src.copied(toNamespace: namespace)
            let applied = await WorkloadCommander(context: context).run(.applySecret(copy))
            guard applied.ok else { return .failed(applied.stderr.isEmpty ? "kubectl exited \(applied.exitCode)" : applied.stderr) }
        }

        // 2. Read the target namespace default SA's current imagePullSecrets.
        let (names, ok) = await read(["get", "serviceaccount", "default", "-n", namespace,
                                      "-o", "jsonpath={.imagePullSecrets[*].name}"])
        guard ok else { return .failed("couldn't read default ServiceAccount in \(namespace): \(names)") }
        let existing = names.split(separator: " ").map(String.init)
        let union = Self.unionImagePullSecrets(existing: existing, adding: account.secretName)
        if union == existing { return .ok }   // already present — nothing to do

        // 3. Write the full unioned list back via a merge patch.
        let patch = Self.saMergePatch(secretNames: union)
        let patched = await WorkloadCommander(context: context).run(
            .command(args: ["patch", "serviceaccount", "default", "-n", namespace, "--type=merge", "-p", patch],
                     label: "Attach pull secret to default ServiceAccount", destructive: false))
        return patched.ok ? .ok : .failed(patched.stderr.isEmpty ? "kubectl exited \(patched.exitCode)" : patched.stderr)
    }
}
