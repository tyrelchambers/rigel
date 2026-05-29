import Foundation

/// Form-side draft + serialization for a Service. Mirrors `Ingress`/`Secret`'s
/// hand-rolled YAML approach — the shape is shallow enough that pulling in a
/// YAML package would be overkill. Build a value with `draft(...)`, then
/// `toYAML()` for `kubectl apply -f -`.
extension Service {
    static let clusterIP = "ClusterIP"
    static let nodePort = "NodePort"
    static let loadBalancer = "LoadBalancer"
    static let externalName = "ExternalName"

    /// All Service types we offer in the editor's type picker.
    static let selectableTypes = [clusterIP, nodePort, loadBalancer]

    /// One editable port row. Carries the fields needed to round-trip back into
    /// `spec.ports`. `targetPort` may be numeric ("8080") or named ("http").
    struct PortDraft: Hashable {
        var name: String
        var port: String        // service port (numeric)
        var targetPort: String  // numeric or named; empty = same as port
        var protocolName: String  // "TCP" | "UDP" | "SCTP"
        var nodePort: String    // numeric; only meaningful for NodePort/LoadBalancer
    }

    /// Annotation kubectl writes server-side; never surfaced to the editor.
    static let lastAppliedAnnotation = "kubectl.kubernetes.io/last-applied-configuration"

    static func draft(
        name: String,
        namespace: String,
        type: String,
        selector: [String: String],
        ports: [PortDraft]
    ) -> Service {
        let specPorts: [Port] = ports.compactMap { row in
            guard let p = Int(row.port.trimmingCharacters(in: .whitespaces)) else { return nil }
            let target: AnyKubeIntOrString?
            let t = row.targetPort.trimmingCharacters(in: .whitespaces)
            if t.isEmpty {
                target = nil
            } else {
                target = AnyKubeIntOrString(t)
            }
            let np = Int(row.nodePort.trimmingCharacters(in: .whitespaces))
            return Port(
                name: row.name.trimmingCharacters(in: .whitespaces).isEmpty ? nil : row.name,
                port: p,
                targetPort: target,
                protocol: row.protocolName.isEmpty ? "TCP" : row.protocolName,
                nodePort: np
            )
        }
        let meta = ObjectMeta(
            name: name,
            namespace: namespace,
            uid: "",
            creationTimestamp: nil,
            labels: nil,
            annotations: nil
        )
        return Service(
            metadata: meta,
            spec: Spec(
                type: type,
                clusterIP: nil,
                selector: selector.isEmpty ? nil : selector,
                ports: specPorts.isEmpty ? nil : specPorts,
                externalName: nil,
                externalIPs: nil
            ),
            status: nil
        )
    }

    func toYAML() -> String {
        var lines: [String] = []
        lines.append("apiVersion: v1")
        lines.append("kind: Service")
        lines.append("metadata:")
        lines.append("  name: \(Self.yamlScalar(metadata.name))")
        if let ns = metadata.namespace {
            lines.append("  namespace: \(Self.yamlScalar(ns))")
        }
        lines.append("spec:")
        if let type = spec?.type, !type.isEmpty {
            lines.append("  type: \(Self.yamlScalar(type))")
        }
        if let selector = spec?.selector, !selector.isEmpty {
            lines.append("  selector:")
            for (k, v) in selector.sorted(by: { $0.key < $1.key }) {
                lines.append("    \(Self.yamlScalar(k)): \(Self.yamlScalar(v))")
            }
        }
        if let ports = spec?.ports, !ports.isEmpty {
            lines.append("  ports:")
            for p in ports {
                lines.append("    - port: \(p.port)")
                if let name = p.name, !name.isEmpty {
                    lines.append("      name: \(Self.yamlScalar(name))")
                }
                if let t = p.targetPort?.stringValue, !t.isEmpty {
                    // Quote named targets; leave numeric bare so k8s reads an Int.
                    if Int(t) != nil {
                        lines.append("      targetPort: \(t)")
                    } else {
                        lines.append("      targetPort: \(Self.yamlScalar(t))")
                    }
                }
                lines.append("      protocol: \(Self.yamlScalar(p.protocol ?? "TCP"))")
                if let np = p.nodePort {
                    lines.append("      nodePort: \(np)")
                }
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// Single-quote scalars — same rule as `Ingress.yamlScalar`.
    static func yamlScalar(_ s: String) -> String {
        "'\(s.replacingOccurrences(of: "'", with: "''"))'"
    }

    // MARK: - Editor seeding (existing → drafts)

    var portDrafts: [PortDraft] {
        (spec?.ports ?? []).map { p in
            PortDraft(
                name: p.name ?? "",
                port: String(p.port),
                targetPort: p.targetPort?.stringValue ?? "",
                protocolName: p.protocol ?? "TCP",
                nodePort: p.nodePort.map(String.init) ?? ""
            )
        }
    }

    // MARK: - Display helpers

    var typeLabel: String { spec?.type ?? Self.clusterIP }

    var isExternalName: Bool { spec?.type == Self.externalName }

    /// Human-readable port summaries, e.g. "80→8080/TCP", with a NodePort suffix
    /// when present ("80:30080→8080/TCP").
    var portSummaries: [String] {
        (spec?.ports ?? []).map { p in
            let target = p.targetPort?.stringValue
            let head: String
            if let np = p.nodePort {
                head = "\(p.port):\(np)"
            } else {
                head = "\(p.port)"
            }
            let arrow = (target != nil && target != String(p.port)) ? "→\(target!)" : ""
            return "\(head)\(arrow)/\(p.protocol ?? "TCP")"
        }
    }

    /// External address — LoadBalancer ingress entries, then static externalIPs,
    /// then the ExternalName target. Nil when there's nothing external.
    var externalAddress: String? {
        let lb = (status?.loadBalancer?.ingress ?? []).compactMap { $0.ip ?? $0.hostname }
        if !lb.isEmpty { return lb.joined(separator: ", ") }
        if let ips = spec?.externalIPs, !ips.isEmpty { return ips.joined(separator: ", ") }
        if let ext = spec?.externalName, !ext.isEmpty { return ext }
        return nil
    }

    /// Ports that can be port-forwarded (everything except ExternalName services).
    var forwardablePorts: [Port] {
        isExternalName ? [] : (spec?.ports ?? [])
    }
}
