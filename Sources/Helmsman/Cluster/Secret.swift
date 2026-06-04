import Foundation

/// Built-in Kubernetes secret types we render type-aware editors for.
/// Anything not in this list shows up as `.other` — view-only.
enum SecretType: String, CaseIterable, Codable, Hashable {
    case opaque = "Opaque"
    case dockerconfigjson = "kubernetes.io/dockerconfigjson"
    case tls = "kubernetes.io/tls"
    case basicAuth = "kubernetes.io/basic-auth"
    case sshAuth = "kubernetes.io/ssh-auth"
    case serviceAccountToken = "kubernetes.io/service-account-token"
    case other = "__other__"

    init(rawType: String?) {
        guard let r = rawType, !r.isEmpty else { self = .opaque; return }
        self = SecretType(rawValue: r) ?? .other
    }

    var displayName: String {
        switch self {
        case .opaque:               return "Opaque"
        case .dockerconfigjson:     return "Docker registry"
        case .tls:                  return "TLS"
        case .basicAuth:            return "Basic auth"
        case .sshAuth:              return "SSH auth"
        case .serviceAccountToken:  return "Service-account token"
        case .other:                return "Other"
        }
    }

    /// Whether the New-secret form should expose this type. SA-token is
    /// controller-managed; "other" is a fallback bucket.
    var isUserCreatable: Bool {
        switch self {
        case .serviceAccountToken, .other: return false
        default:                           return true
        }
    }

    /// Canonical data keys for this type. Used by the type-aware editor to
    /// pre-populate rows and validate before submit.
    var canonicalKeys: [String] {
        switch self {
        case .opaque:               return []
        case .dockerconfigjson:     return [".dockerconfigjson"]
        case .tls:                  return ["tls.crt", "tls.key"]
        case .basicAuth:            return ["username", "password"]
        case .sshAuth:              return ["ssh-privatekey"]
        case .serviceAccountToken: return []
        case .other:                return []
        }
    }
}

struct Secret: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let type: String?
    /// Always base64-encoded as returned by `kubectl get -o json`. Use
    /// `decoded(_:)` for UTF-8 round-trip.
    let data: [String: String]?

    var id: String { metadata.uid }
    var secretType: SecretType { SecretType(rawType: type) }

    var keysSorted: [String] {
        (data ?? [:]).keys.sorted()
    }

    /// Decoded UTF-8 view of a key, or nil for binary / missing.
    func decoded(_ key: String) -> String? {
        guard let b64 = data?[key], let bytes = Data(base64Encoded: b64) else { return nil }
        return String(data: bytes, encoding: .utf8)
    }

    /// Raw bytes for a key. Use for size readouts on binary values.
    func rawBytes(_ key: String) -> Data? {
        guard let b64 = data?[key] else { return nil }
        return Data(base64Encoded: b64)
    }
}

extension Secret {
    /// Build a Secret value ready for `kubectl apply -f -`. Server-assigned
    /// metadata fields (uid, resourceVersion, creationTimestamp) are dropped;
    /// annotations are intentionally not carried over, since the most common
    /// one (`kubectl.kubernetes.io/last-applied-configuration`) would leak the
    /// previous data payload and kubectl regenerates it anyway.
    static func draft(
        name: String,
        namespace: String,
        type: SecretType,
        decodedData: [String: String],
        labels: [String: String]? = nil
    ) -> Secret {
        let encoded = decodedData.mapValues { Data($0.utf8).base64EncodedString() }
        let meta = ObjectMeta(
            name: name,
            namespace: namespace,
            uid: "",
            creationTimestamp: nil,
            labels: (labels?.isEmpty == false) ? labels : nil,
            annotations: nil
        )
        let raw = type == .other ? "Opaque" : type.rawValue
        return Secret(metadata: meta, type: raw, data: encoded)
    }

    /// A copy of this Secret retargeted to another namespace, with server-assigned
    /// metadata (uid, creationTimestamp, annotations) dropped so it applies cleanly
    /// via `kubectl apply -f -`. The base64 `data` payload is preserved verbatim,
    /// so this works for copying a pull Secret across namespaces without decoding it.
    func copied(toNamespace ns: String) -> Secret {
        let meta = ObjectMeta(
            name: metadata.name,
            namespace: ns,
            uid: "",
            creationTimestamp: nil,
            labels: metadata.labels,
            annotations: nil
        )
        return Secret(metadata: meta, type: type, data: data)
    }

    /// YAML for `kubectl apply -f -`. Hand-rolled — Secret's shape is shallow
    /// enough that pulling in a YAML package would be overkill.
    func toYAML() -> String {
        var lines: [String] = []
        lines.append("apiVersion: v1")
        lines.append("kind: Secret")
        lines.append("metadata:")
        lines.append("  name: \(Self.yamlScalar(metadata.name))")
        if let ns = metadata.namespace {
            lines.append("  namespace: \(Self.yamlScalar(ns))")
        }
        if let labels = metadata.labels, !labels.isEmpty {
            lines.append("  labels:")
            for (k, v) in labels.sorted(by: { $0.key < $1.key }) {
                lines.append("    \(Self.yamlScalar(k)): \(Self.yamlScalar(v))")
            }
        }
        let effectiveType = (type?.isEmpty == false) ? type! : SecretType.opaque.rawValue
        lines.append("type: \(Self.yamlScalar(effectiveType))")
        if let data, !data.isEmpty {
            lines.append("data:")
            for (k, v) in data.sorted(by: { $0.key < $1.key }) {
                lines.append("  \(Self.yamlScalar(k)): \(Self.yamlScalar(v))")
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// Always single-quote scalars — covers keys with dots, base64 with `=`,
    /// and arbitrary user input without needing per-character escaping.
    static func yamlScalar(_ s: String) -> String {
        "'\(s.replacingOccurrences(of: "'", with: "''"))'"
    }
}
