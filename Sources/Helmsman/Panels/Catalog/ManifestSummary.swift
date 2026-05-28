import Foundation
import Yams

/// Structured, display-oriented view of a (possibly multi-document) Kubernetes
/// manifest. Built tolerantly from raw YAML so a partially-formed or slightly
/// off-spec manifest still renders something useful instead of nothing.
struct ManifestSummary {
    var workloads: [WorkloadSummary] = []
    var services: [ServiceSummary] = []
    var ingresses: [IngressSummary] = []
    var volumes: [VolumeSummary] = []
    var configs: [ConfigSummary] = []
    var others: [OtherResource] = []

    var isEmpty: Bool {
        workloads.isEmpty && services.isEmpty && ingresses.isEmpty
            && volumes.isEmpty && configs.isEmpty && others.isEmpty
    }

    /// Parse every document in `yaml`. Returns nil when nothing recognizable
    /// could be extracted (empty input, parse failure, or no known kinds).
    static func parse(_ yaml: String) -> ManifestSummary? {
        let trimmed = yaml.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let docs: [[String: Any]]
        do {
            docs = try Yams.load_all(yaml: trimmed).compactMap { $0 as? [String: Any] }
        } catch {
            return nil
        }
        guard !docs.isEmpty else { return nil }

        var summary = ManifestSummary()
        for doc in docs {
            let kind = (doc["kind"] as? String) ?? ""
            let meta = dict(doc["metadata"])
            let name = (meta?["name"] as? String) ?? "(unnamed)"
            let namespace = meta?["namespace"] as? String
            let labels = stringMap(meta?["labels"])

            switch kind {
            case "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod":
                summary.workloads.append(
                    parseWorkload(kind: kind, name: name, namespace: namespace, labels: labels, doc: doc)
                )
            case "Service":
                summary.services.append(parseService(name: name, doc: doc))
            case "Ingress":
                summary.ingresses.append(parseIngress(name: name, doc: doc))
            case "PersistentVolumeClaim":
                summary.volumes.append(parseVolume(name: name, doc: doc))
            case "ConfigMap", "Secret":
                let keys = (dict(doc["data"])?.count ?? 0) + (dict(doc["stringData"])?.count ?? 0)
                summary.configs.append(ConfigSummary(kind: kind, name: name, keyCount: keys))
            case "":
                continue
            default:
                summary.others.append(OtherResource(kind: kind, name: name))
            }
        }
        return summary.isEmpty ? nil : summary
    }

    // MARK: - Per-kind parsing

    private static func parseWorkload(
        kind: String, name: String, namespace: String?,
        labels: [String: String], doc: [String: Any]
    ) -> WorkloadSummary {
        let spec = dict(doc["spec"])
        let podSpec = podSpec(forKind: kind, spec: spec)
        let replicas = (kind == "Pod" || kind == "DaemonSet" || kind == "Job")
            ? nil : int(spec?["replicas"])

        var nodePin = str(podSpec?["nodeName"])
        if nodePin == nil, let selector = stringMapOptional(podSpec?["nodeSelector"]) {
            nodePin = selector["kubernetes.io/hostname"]
        }

        let containers = (arr(podSpec?["containers"]) ?? []).compactMap { parseContainer($0) }
        return WorkloadSummary(
            kind: kind, name: name, namespace: namespace, replicas: replicas,
            labels: labels, nodePin: nodePin, containers: containers
        )
    }

    /// Locate the pod template spec, which nests differently per workload kind.
    private static func podSpec(forKind kind: String, spec: [String: Any]?) -> [String: Any]? {
        switch kind {
        case "Pod":
            return spec
        case "CronJob":
            return dict(dict(dict(dict(spec?["jobTemplate"])?["spec"])?["template"])?["spec"])
        default:
            return dict(dict(spec?["template"])?["spec"])
        }
    }

    private static func parseContainer(_ any: Any) -> ContainerSummary? {
        guard let c = any as? [String: Any] else { return nil }
        let name = (c["name"] as? String) ?? "(container)"
        let image = (c["image"] as? String) ?? "—"
        let resources = dict(c["resources"])
        let requests = dict(resources?["requests"])
        let limits = dict(resources?["limits"])
        let ports = (arr(c["ports"]) ?? []).compactMap { int(dict($0)?["containerPort"]) }
        return ContainerSummary(
            name: name,
            image: image,
            cpuRequest: str(requests?["cpu"]),
            cpuLimit: str(limits?["cpu"]),
            memRequest: str(requests?["memory"]),
            memLimit: str(limits?["memory"]),
            ports: ports
        )
    }

    private static func parseService(name: String, doc: [String: Any]) -> ServiceSummary {
        let spec = dict(doc["spec"])
        let type = (spec?["type"] as? String) ?? "ClusterIP"
        let ports = (arr(spec?["ports"]) ?? []).compactMap { any -> PortMapping? in
            guard let p = any as? [String: Any], let port = int(p["port"]) else { return nil }
            return PortMapping(port: port, targetPort: str(p["targetPort"]), proto: str(p["protocol"]))
        }
        return ServiceSummary(name: name, type: type, ports: ports)
    }

    private static func parseIngress(name: String, doc: [String: Any]) -> IngressSummary {
        let spec = dict(doc["spec"])
        let tls = !(arr(spec?["tls"]) ?? []).isEmpty
        let rules = (arr(spec?["rules"]) ?? []).map { any -> IngressRule in
            let r = (any as? [String: Any]) ?? [:]
            let host = str(r["host"])
            let paths = (arr(dict(r["http"])?["paths"]) ?? []).map { p -> IngressPath in
                let pd = (p as? [String: Any]) ?? [:]
                let path = (pd["path"] as? String) ?? "/"
                let backend = dict(pd["backend"])
                // networking.k8s.io/v1 shape, with a fallback to the legacy keys.
                let svcDict = dict(backend?["service"])
                let svc = str(svcDict?["name"]) ?? str(backend?["serviceName"])
                let portDict = dict(svcDict?["port"])
                let port = str(portDict?["number"]) ?? str(portDict?["name"]) ?? str(backend?["servicePort"])
                return IngressPath(path: path, service: svc, port: port)
            }
            return IngressRule(host: host, paths: paths)
        }
        return IngressSummary(name: name, rules: rules, tls: tls)
    }

    private static func parseVolume(name: String, doc: [String: Any]) -> VolumeSummary {
        let spec = dict(doc["spec"])
        let size = str(dict(dict(spec?["resources"])?["requests"])?["storage"])
        let modes = (arr(spec?["accessModes"]) ?? []).compactMap { str($0) }
        return VolumeSummary(
            name: name, size: size, accessModes: modes,
            storageClass: str(spec?["storageClassName"])
        )
    }

    // MARK: - Scalar/collection coercion helpers

    private static func dict(_ v: Any?) -> [String: Any]? { v as? [String: Any] }
    private static func arr(_ v: Any?) -> [Any]? { v as? [Any] }

    private static func str(_ v: Any?) -> String? {
        switch v {
        case let s as String: return s
        case let i as Int:    return String(i)
        case let d as Double: return d == d.rounded() ? String(Int(d)) : String(d)
        case let b as Bool:   return b ? "true" : "false"
        default:              return nil
        }
    }

    private static func int(_ v: Any?) -> Int? {
        switch v {
        case let i as Int:    return i
        case let s as String: return Int(s)
        case let d as Double: return Int(d)
        default:              return nil
        }
    }

    private static func stringMap(_ v: Any?) -> [String: String] {
        stringMapOptional(v) ?? [:]
    }

    private static func stringMapOptional(_ v: Any?) -> [String: String]? {
        guard let d = v as? [String: Any] else { return nil }
        var out: [String: String] = [:]
        for (k, val) in d { if let s = str(val) { out[k] = s } }
        return out
    }
}

// MARK: - Component models

struct WorkloadSummary: Identifiable {
    let id = UUID()
    let kind: String
    let name: String
    let namespace: String?
    let replicas: Int?
    let labels: [String: String]
    let nodePin: String?
    let containers: [ContainerSummary]
}

struct ContainerSummary: Identifiable {
    let id = UUID()
    let name: String
    let image: String
    let cpuRequest: String?
    let cpuLimit: String?
    let memRequest: String?
    let memLimit: String?
    let ports: [Int]

    /// `repo` and `tag` split at the tag separator, ignoring any registry port.
    var imageParts: (repo: String, tag: String) {
        let lastSlash = image.lastIndex(of: "/")
        let searchStart = lastSlash.map { image.index(after: $0) } ?? image.startIndex
        if let colon = image[searchStart...].lastIndex(of: ":") {
            return (String(image[..<colon]), String(image[image.index(after: colon)...]))
        }
        return (image, "latest")
    }
}

struct ServiceSummary: Identifiable {
    let id = UUID()
    let name: String
    let type: String
    let ports: [PortMapping]
}

struct PortMapping: Identifiable {
    let id = UUID()
    let port: Int
    let targetPort: String?
    let proto: String?
}

struct IngressSummary: Identifiable {
    let id = UUID()
    let name: String
    let rules: [IngressRule]
    let tls: Bool
}

struct IngressRule: Identifiable {
    let id = UUID()
    let host: String?
    let paths: [IngressPath]
}

struct IngressPath: Identifiable {
    let id = UUID()
    let path: String
    let service: String?
    let port: String?
}

struct VolumeSummary: Identifiable {
    let id = UUID()
    let name: String
    let size: String?
    let accessModes: [String]
    let storageClass: String?
}

struct ConfigSummary: Identifiable {
    let id = UUID()
    let kind: String
    let name: String
    let keyCount: Int
}

struct OtherResource: Identifiable {
    let id = UUID()
    let kind: String
    let name: String
}
