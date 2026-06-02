import Foundation

/// How the wizard arrived at the Secret name — drives the Secrets-step banner.
enum SecretNameNote: Equatable {
    case fresh                          // base name was free
    case reusing                        // an existing helmsman-managed Secret for this install
    case suffixed(requested: String)    // base name was taken by an unrelated Secret
}

/// Locally-generated strong secret values (passwords, signing keys, access keys).
/// Alphanumeric only, to stay safe inside YAML scalars and shell args.
enum RandomSecret {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")

    static func generate(length: Int = 32) -> String {
        let n = max(1, length)
        var out = ""
        out.reserveCapacity(n)
        for _ in 0..<n {
            out.append(alphabet[Int.random(in: 0..<alphabet.count)])
        }
        return out
    }
}

/// Decides the Secret name for an install, keeping it collision-safe and
/// reusing a prior install's Secret when it is clearly ours.
enum SecretNameResolver {
    static let managedByLabel = "app.kubernetes.io/managed-by"
    static let instanceLabel = "app.kubernetes.io/instance"
    static let managedByValue = "helmsman"

    struct Resolution: Equatable {
        let name: String
        let note: SecretNameNote
        let prefill: [String: String]
    }

    /// `existing` = the Secrets currently in the target namespace.
    static func resolve(instance: String, existing: [Secret]) -> Resolution {
        let base = "\(instance)-secrets"
        let byName = Dictionary(existing.map { ($0.metadata.name, $0) }, uniquingKeysWith: { a, _ in a })

        if let mine = byName[base], isOurs(mine, instance: instance) {
            var prefill: [String: String] = [:]
            for k in mine.keysSorted { if let v = mine.decoded(k) { prefill[k] = v } }
            return Resolution(name: base, note: .reusing, prefill: prefill)
        }
        if byName[base] == nil {
            return Resolution(name: base, note: .fresh, prefill: [:])
        }
        // Base taken by an unrelated Secret — find the first free suffix.
        var n = 2
        while byName["\(base)-\(n)"] != nil { n += 1 }
        return Resolution(name: "\(base)-\(n)", note: .suffixed(requested: base), prefill: [:])
    }

    private static func isOurs(_ s: Secret, instance: String) -> Bool {
        let labels = s.metadata.labels ?? [:]
        return labels[managedByLabel] == managedByValue && labels[instanceLabel] == instance
    }
}

/// Best-effort read of the Secrets in a namespace, so the resolver can detect
/// name collisions / reuse. Modeled on `ClusterIssuerLoader`. Any failure
/// (kubectl missing, RBAC, no namespace) yields `[]` — the caller then treats
/// the base name as free.
enum NamespaceSecretsProbe {
    private struct SecretList: Decodable { let items: [Secret] }

    static func load(namespace: String, context: String?) async -> [Secret] {
        guard let kubectl = resolveBinary("kubectl") else { return [] }
        var args: [String] = []
        if let context { args.append(contentsOf: ["--context", context]) }
        args.append(contentsOf: ["get", "secret", "-n", namespace, "-o", "json"])
        guard let data = try? await runProcess(kubectl, args: args),
              let list = try? JSONDecoder().decode(SecretList.self, from: data) else { return [] }
        return list.items
    }
}
