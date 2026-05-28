import Foundation

/// Form-side draft + serialization for an Ingress. Mirrors `Secret`'s
/// hand-rolled YAML approach — the shape is shallow enough that pulling in a
/// YAML package would be overkill. Build a value with `draft(...)`, then
/// `toYAML()` for `kubectl apply -f -`.
extension Ingress {
    /// One editable routing row. Carries the fields needed to round-trip back
    /// into `spec.rules`; grouped by host at build time.
    struct RuleDraft: Hashable {
        var host: String
        var path: String
        var pathType: String   // "Prefix" | "Exact" | "ImplementationSpecific"
        var service: String
        var port: String       // numeric ("80") or named ("http")
    }

    struct TLSDraft: Hashable {
        var host: String
        var secretName: String
    }

    /// Annotation cert-manager watches to issue a certificate for the ingress.
    static let certManagerIssuerAnnotation = "cert-manager.io/cluster-issuer"
    /// Annotation kubectl writes server-side; never surfaced to the editor.
    static let lastAppliedAnnotation = "kubectl.kubernetes.io/last-applied-configuration"

    static func draft(
        name: String,
        namespace: String,
        className: String,
        rules: [RuleDraft],
        tls: [TLSDraft],
        annotations: [String: String]
    ) -> Ingress {
        // Group rule rows by host → one Rule per host with N paths.
        var byHost: [String: [Path]] = [:]
        var hostOrder: [String] = []
        for r in rules where !r.service.trimmingCharacters(in: .whitespaces).isEmpty {
            if byHost[r.host] == nil { hostOrder.append(r.host) }
            let port: ServicePort = Int(r.port).map { ServicePort(number: $0, name: nil) }
                ?? ServicePort(number: nil, name: r.port.isEmpty ? nil : r.port)
            let path = Path(
                path: r.path.isEmpty ? "/" : r.path,
                pathType: r.pathType.isEmpty ? "Prefix" : r.pathType,
                backend: Backend(service: ServiceBackend(name: r.service, port: port))
            )
            byHost[r.host, default: []].append(path)
        }
        let specRules: [Rule] = hostOrder.map { host in
            Rule(host: host.isEmpty ? nil : host, http: HTTP(paths: byHost[host] ?? []))
        }

        // Group TLS rows by secretName → one TLS entry per secret with N hosts.
        var bySecret: [String: [String]] = [:]
        var secretOrder: [String] = []
        for t in tls where !t.secretName.trimmingCharacters(in: .whitespaces).isEmpty {
            if bySecret[t.secretName] == nil { secretOrder.append(t.secretName) }
            if !t.host.isEmpty { bySecret[t.secretName, default: []].append(t.host) }
        }
        let specTLS: [TLS] = secretOrder.map { secret in
            let hosts = bySecret[secret] ?? []
            return TLS(hosts: hosts.isEmpty ? nil : hosts, secretName: secret)
        }

        let meta = ObjectMeta(
            name: name,
            namespace: namespace,
            uid: "",
            creationTimestamp: nil,
            labels: nil,
            annotations: annotations.isEmpty ? nil : annotations
        )
        return Ingress(
            metadata: meta,
            spec: Spec(
                ingressClassName: className.isEmpty ? nil : className,
                tls: specTLS.isEmpty ? nil : specTLS,
                rules: specRules.isEmpty ? nil : specRules,
                defaultBackend: nil
            ),
            status: nil
        )
    }

    func toYAML() -> String {
        var lines: [String] = []
        lines.append("apiVersion: networking.k8s.io/v1")
        lines.append("kind: Ingress")
        lines.append("metadata:")
        lines.append("  name: \(Self.yamlScalar(metadata.name))")
        if let ns = metadata.namespace {
            lines.append("  namespace: \(Self.yamlScalar(ns))")
        }
        if let ann = metadata.annotations, !ann.isEmpty {
            lines.append("  annotations:")
            for (k, v) in ann.sorted(by: { $0.key < $1.key }) {
                lines.append("    \(Self.yamlScalar(k)): \(Self.yamlScalar(v))")
            }
        }
        lines.append("spec:")
        if let cls = spec?.ingressClassName, !cls.isEmpty {
            lines.append("  ingressClassName: \(Self.yamlScalar(cls))")
        }
        if let tls = spec?.tls, !tls.isEmpty {
            lines.append("  tls:")
            for entry in tls {
                lines.append("    - secretName: \(Self.yamlScalar(entry.secretName ?? ""))")
                if let hosts = entry.hosts, !hosts.isEmpty {
                    lines.append("      hosts:")
                    for h in hosts { lines.append("        - \(Self.yamlScalar(h))") }
                }
            }
        }
        if let rules = spec?.rules, !rules.isEmpty {
            lines.append("  rules:")
            for rule in rules {
                // `first` tracks whether we still owe the list-item dash. The dash
                // goes on whichever key we emit first (host, else http), so the
                // remaining keys align under it regardless of whether a host exists.
                var first = true
                if let host = rule.host, !host.isEmpty {
                    lines.append("    - host: \(Self.yamlScalar(host))")
                    first = false
                }
                let paths = rule.http?.paths ?? []
                guard !paths.isEmpty else {
                    if first { lines.append("    - {}") }   // hostless, pathless — keep valid YAML
                    continue
                }
                lines.append(first ? "    - http:" : "      http:")
                lines.append("        paths:")
                for p in paths {
                    lines.append("          - path: \(Self.yamlScalar(p.path ?? "/"))")
                    lines.append("            pathType: \(Self.yamlScalar(p.pathType ?? "Prefix"))")
                    lines.append("            backend:")
                    lines.append("              service:")
                    lines.append("                name: \(Self.yamlScalar(p.backend.service?.name ?? ""))")
                    if let port = p.backend.service?.port {
                        lines.append("                port:")
                        if let n = port.number {
                            lines.append("                  number: \(n)")
                        } else if let name = port.name {
                            lines.append("                  name: \(Self.yamlScalar(name))")
                        }
                    }
                }
            }
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// Single-quote scalars — same rule as `Secret.yamlScalar`.
    static func yamlScalar(_ s: String) -> String {
        "'\(s.replacingOccurrences(of: "'", with: "''"))'"
    }

    // MARK: - Editor seeding (existing → drafts)

    /// One editable rule row per host+path in `spec.rules`.
    var ruleDrafts: [RuleDraft] {
        var out: [RuleDraft] = []
        for rule in spec?.rules ?? [] {
            for p in rule.http?.paths ?? [] {
                out.append(RuleDraft(
                    host: rule.host ?? "",
                    path: p.path ?? "/",
                    pathType: p.pathType ?? "Prefix",
                    service: p.backend.service?.name ?? "",
                    port: Self.portLabel(p.backend.service?.port)
                ))
            }
        }
        return out
    }

    /// One editable TLS row per host (or one row with empty host if none listed).
    var tlsDrafts: [TLSDraft] {
        var out: [TLSDraft] = []
        for entry in spec?.tls ?? [] {
            let secret = entry.secretName ?? ""
            let hosts = entry.hosts ?? []
            if hosts.isEmpty {
                out.append(TLSDraft(host: "", secretName: secret))
            } else {
                for h in hosts { out.append(TLSDraft(host: h, secretName: secret)) }
            }
        }
        return out
    }

    /// Annotations minus kubectl's server-managed last-applied blob.
    var editableAnnotations: [String: String] {
        (metadata.annotations ?? [:]).filter { $0.key != Self.lastAppliedAnnotation }
    }
}
