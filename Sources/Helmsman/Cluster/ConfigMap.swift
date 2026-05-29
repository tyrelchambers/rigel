import Foundation
import Yams

struct ConfigMap: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    /// Plaintext key/value pairs (UTF-8). Editable.
    let data: [String: String]?
    /// Base64-encoded binary values. Surfaced read-only — the editor only
    /// touches `data`.
    let binaryData: [String: String]?

    var id: String { metadata.uid }

    /// All keys across `data` + `binaryData`, sorted for stable display.
    var keysSorted: [String] {
        Set((data ?? [:]).keys).union((binaryData ?? [:]).keys).sorted()
    }

    var keyCount: Int { (data?.count ?? 0) + (binaryData?.count ?? 0) }

    /// Raw bytes for a binary key, for size readouts.
    func binaryBytes(_ key: String) -> Int {
        guard let b64 = binaryData?[key] else { return 0 }
        return Data(base64Encoded: b64)?.count ?? 0
    }
}

extension ConfigMap {
    /// Annotation kubectl writes server-side; never surfaced to the editor.
    static let lastAppliedAnnotation = "kubectl.kubernetes.io/last-applied-configuration"

    /// Build a ConfigMap value ready for `kubectl apply -f -`. Server-assigned
    /// metadata (uid, resourceVersion, creationTimestamp) is dropped; the
    /// editor only writes plaintext `data`.
    static func draft(
        name: String,
        namespace: String,
        data: [String: String],
        binaryData: [String: String]? = nil,
        labels: [String: String]? = nil
    ) -> ConfigMap {
        let meta = ObjectMeta(
            name: name,
            namespace: namespace,
            uid: "",
            creationTimestamp: nil,
            labels: (labels?.isEmpty == false) ? labels : nil,
            annotations: nil
        )
        // Carry binaryData through unchanged — the editor can't touch it, but an
        // edit-then-apply must not drop it via the 3-way merge.
        return ConfigMap(
            metadata: meta,
            data: data.isEmpty ? nil : data,
            binaryData: (binaryData?.isEmpty == false) ? binaryData : nil
        )
    }

    /// YAML for `kubectl apply -f -`. Unlike Secret/Ingress, ConfigMap values are
    /// frequently whole config files (multi-line), so we use Yams rather than
    /// hand-rolled single-quoting — it emits correct block scalars. `sortKeys`
    /// keeps output deterministic; key order is irrelevant to `kubectl apply`.
    func toYAML() -> String {
        var root: [String: Any] = [
            "apiVersion": "v1",
            "kind": "ConfigMap",
        ]
        var meta: [String: Any] = ["name": metadata.name]
        if let ns = metadata.namespace { meta["namespace"] = ns }
        if let labels = metadata.labels, !labels.isEmpty { meta["labels"] = labels }
        root["metadata"] = meta
        if let data, !data.isEmpty { root["data"] = data }
        if let binaryData, !binaryData.isEmpty { root["binaryData"] = binaryData }
        return (try? Yams.dump(object: root, sortKeys: true)) ?? ""
    }

    /// Annotations minus kubectl's server-managed last-applied blob.
    var editableAnnotations: [String: String] {
        (metadata.annotations ?? [:]).filter { $0.key != Self.lastAppliedAnnotation }
    }
}
