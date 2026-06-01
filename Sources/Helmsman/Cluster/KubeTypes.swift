import Foundation

struct KubeList<T: Codable>: Codable {
    let items: [T]
}

struct ObjectMeta: Codable, Hashable {
    let name: String
    let namespace: String?
    let uid: String
    let creationTimestamp: Date?
    let labels: [String: String]?
    let annotations: [String: String]?
}

struct Pod: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: PodSpec?
    let status: PodStatus?

    var id: String { metadata.uid }
}

struct PodSpec: Codable, Hashable {
    let nodeName: String?
    let containers: [Container]
}

struct Container: Codable, Hashable {
    let name: String
    let image: String?
    let resources: ResourceRequirements?
    let ports: [ContainerPort]?
}

struct ResourceRequirements: Codable, Hashable {
    let requests: [String: String]?   // "cpu", "memory", ...
    let limits: [String: String]?
}

struct ContainerPort: Codable, Hashable {
    let name: String?
    let containerPort: Int
    let `protocol`: String?
}

struct PodStatus: Codable, Hashable {
    let phase: String?
    let podIP: String?
    let containerStatuses: [ContainerStatus]?
}

struct ContainerStatus: Codable, Hashable {
    let name: String
    let ready: Bool
    let restartCount: Int
    let state: ContainerState?
}

struct ContainerState: Codable, Hashable {
    let running: RunningState?
    let waiting: WaitingState?
    let terminated: TerminatedState?
}

struct RunningState: Codable, Hashable { let startedAt: Date? }
struct WaitingState: Codable, Hashable { let reason: String?; let message: String? }
struct TerminatedState: Codable, Hashable {
    let reason: String?
    let message: String?
    let exitCode: Int?
}

extension Pod {
    /// Reasons we treat as "this pod is broken right now". nil = pod is healthy
    /// or in a benign transitional state (Pending while pulling, etc).
    private static let errorWaitingReasons: Set<String> = [
        "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull",
        "CreateContainerConfigError", "RunContainerError", "InvalidImageName",
    ]

    /// Human-readable error reason, or nil when the pod is OK.
    /// Used by notifications, suggested prompts, and deployment health colors.
    var errorReason: String? {
        if status?.phase == "Failed" { return "Failed" }
        for cs in status?.containerStatuses ?? [] {
            if let reason = cs.state?.waiting?.reason, Pod.errorWaitingReasons.contains(reason) {
                return reason
            }
        }
        return nil
    }
}

extension JSONDecoder {
    static var kube: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}

struct Deployment: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: DeploymentSpec?
    let status: DeploymentStatus?
    var id: String { metadata.uid }
}

struct DeploymentSpec: Codable, Hashable {
    let replicas: Int?
    let selector: LabelSelector?
    let template: PodTemplate?
    let strategy: DeploymentStrategy?
    let paused: Bool?
}

struct DeploymentStrategy: Codable, Hashable {
    let type: String?                              // "RollingUpdate" | "Recreate"
    let rollingUpdate: RollingUpdateStrategy?
}

struct RollingUpdateStrategy: Codable, Hashable {
    /// Can be Int or String ("25%") in the k8s API; we keep the raw JSON for display.
    let maxSurge: AnyKubeIntOrString?
    let maxUnavailable: AnyKubeIntOrString?
}

/// Tolerant Codable for k8s `IntOrString` (numbers OR percentage strings).
struct AnyKubeIntOrString: Codable, Hashable {
    let stringValue: String

    /// Wrap a raw value (numeric or named) the user typed in a form.
    init(_ stringValue: String) { self.stringValue = stringValue }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { stringValue = s }
        else if let i = try? c.decode(Int.self) { stringValue = "\(i)" }
        else { stringValue = "?" }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(stringValue)
    }
}

struct DeploymentStatus: Codable, Hashable {
    let replicas: Int?
    let readyReplicas: Int?
    let availableReplicas: Int?
    let updatedReplicas: Int?
}

struct LabelSelector: Codable, Hashable {
    let matchLabels: [String: String]?
}

// MARK: - Nodes

struct Node: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: NodeSpec?
    let status: NodeStatus?
    var id: String { metadata.uid }
}

struct NodeSpec: Codable, Hashable {
    let podCIDR: String?
    let providerID: String?
    let unschedulable: Bool?
    let taints: [NodeTaint]?
}

struct NodeTaint: Codable, Hashable {
    let key: String
    let value: String?
    /// `NoSchedule` | `PreferNoSchedule` | `NoExecute`
    let effect: String
}

struct NodeStatus: Codable, Hashable {
    let capacity: [String: String]?       // "cpu", "memory", "ephemeral-storage", "pods"
    let allocatable: [String: String]?
    let conditions: [NodeCondition]?
    let addresses: [NodeAddress]?
    let nodeInfo: NodeInfo?
}

struct NodeCondition: Codable, Hashable {
    let type: String
    let status: String
    let reason: String?
    let message: String?
}

struct NodeAddress: Codable, Hashable {
    let type: String
    let address: String
}

struct NodeInfo: Codable, Hashable {
    let kernelVersion: String?
    let osImage: String?
    let containerRuntimeVersion: String?
    let kubeletVersion: String?
    let architecture: String?
    let operatingSystem: String?
}

extension Node {
    var isReady: Bool {
        status?.conditions?.first(where: { $0.type == "Ready" })?.status == "True"
    }

    var role: String {
        let labels = metadata.labels ?? [:]
        if labels["node-role.kubernetes.io/control-plane"] != nil { return "control-plane" }
        if labels["node-role.kubernetes.io/master"] != nil { return "control-plane" }
        if labels["node-role.kubernetes.io/worker"] != nil { return "worker" }
        return "worker"
    }
}

struct NodeMetrics: Codable, Identifiable, Hashable {
    struct Meta: Codable, Hashable { let name: String }
    struct Usage: Codable, Hashable {
        let cpu: String
        let memory: String
    }
    let metadata: Meta
    let usage: Usage
    var id: String { metadata.name }
}

struct NodeMetricsList: Codable {
    let items: [NodeMetrics]
}

struct PodMetrics: Codable, Hashable {
    struct Meta: Codable, Hashable {
        let name: String
        let namespace: String?
    }
    struct ContainerUsage: Codable, Hashable {
        let name: String
        let usage: NodeMetrics.Usage   // { cpu, memory }
    }
    let metadata: Meta
    let containers: [ContainerUsage]
    let timestamp: Date?
    let window: String?

    /// Key matching how we index in ClusterCache: `namespace/name`.
    var key: String { "\(metadata.namespace ?? "default")/\(metadata.name)" }

    var totalCPUCores: Double {
        containers.reduce(0) { $0 + ResourceQuantity.cpuCores($1.usage.cpu) }
    }
    var totalMemBytes: Double {
        containers.reduce(0) { $0 + ResourceQuantity.bytes($1.usage.memory) }
    }
}

struct PodMetricsList: Codable {
    let items: [PodMetrics]
}

/// One sample point in the per-pod sparkline ring buffer.
struct PodMetricSample: Hashable {
    let cpuCores: Double
    let memBytes: Double
}

// MARK: - Events

struct K8sEvent: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let type: String?              // "Normal" | "Warning"
    let reason: String?
    let message: String?
    let count: Int?
    let firstTimestamp: Date?
    let lastTimestamp: Date?
    let involvedObject: InvolvedObject?
    var id: String { metadata.uid }
}

struct InvolvedObject: Codable, Hashable {
    let kind: String?
    let name: String?
    let namespace: String?
    let uid: String?
}

extension K8sEvent {
    var isWarning: Bool { type == "Warning" }
    /// Best timestamp we have for "when did this last happen".
    var when: Date? { lastTimestamp ?? firstTimestamp ?? metadata.creationTimestamp }

    /// Compact relative age of `when` ("5s" / "3m" / "2h" / "1d"), or "—" if the
    /// event carries no usable timestamp. Shared by every warning/event surface
    /// so they read identically. Pass `now` in tests for determinism.
    func relativeAge(now: Date = Date()) -> String {
        guard let when else { return "—" }
        let dt = now.timeIntervalSince(when)
        if dt < 0 { return "0s" }
        if dt < 60 { return "\(Int(dt))s" }
        if dt < 3600 { return "\(Int(dt / 60))m" }
        if dt < 86400 { return "\(Int(dt / 3600))h" }
        return "\(Int(dt / 86400))d"
    }

    /// Full absolute timestamp for hover/tooltip, e.g. "Jun 1, 2026 at 8:14:02 AM",
    /// or nil when the event has no timestamp.
    var absoluteWhen: String? {
        when?.formatted(date: .abbreviated, time: .standard)
    }
}

// MARK: - StatefulSets

struct StatefulSet: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: StatefulSetSpec?
    let status: StatefulSetStatus?
    var id: String { metadata.uid }
}

struct StatefulSetSpec: Codable, Hashable {
    let replicas: Int?
    let selector: LabelSelector?
    let template: PodTemplate?
}

struct StatefulSetStatus: Codable, Hashable {
    let replicas: Int?
    let readyReplicas: Int?
    let currentReplicas: Int?
    let updatedReplicas: Int?
}

struct PodTemplate: Codable, Hashable {
    let spec: PodSpec?
}

// MARK: - CNPG (CloudNativePG) Cluster CR

struct CNPGCluster: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: CNPGClusterSpec?
    let status: CNPGClusterStatus?
    var id: String { metadata.uid }
}

struct CNPGClusterSpec: Codable, Hashable {
    let instances: Int?
    let imageName: String?
}

struct CNPGClusterStatus: Codable, Hashable {
    let phase: String?
    let instances: Int?
    let readyInstances: Int?
    let currentPrimary: String?
    let targetPrimary: String?
}

// MARK: - Ingresses (networking.k8s.io/v1)
// Sub-types are nested under `Ingress` to avoid colliding with the Catalog's
// manifest-summary types (IngressRule / IngressPath).

struct Ingress: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: Spec?
    let status: Status?
    var id: String { metadata.uid }

    struct Spec: Codable, Hashable {
        let ingressClassName: String?
        let tls: [TLS]?
        let rules: [Rule]?
        let defaultBackend: Backend?
    }

    struct TLS: Codable, Hashable {
        let hosts: [String]?
        let secretName: String?
    }

    struct Rule: Codable, Hashable {
        let host: String?
        let http: HTTP?
    }

    struct HTTP: Codable, Hashable {
        let paths: [Path]
    }

    struct Path: Codable, Hashable {
        let path: String?
        let pathType: String?
        let backend: Backend
    }

    struct Backend: Codable, Hashable {
        let service: ServiceBackend?
    }

    struct ServiceBackend: Codable, Hashable {
        let name: String
        let port: ServicePort?
    }

    struct ServicePort: Codable, Hashable {
        let number: Int?
        let name: String?
    }

    struct Status: Codable, Hashable {
        let loadBalancer: LoadBalancer?
    }

    struct LoadBalancer: Codable, Hashable {
        let ingress: [LBEntry]?
    }

    struct LBEntry: Codable, Hashable {
        let ip: String?
        let hostname: String?
    }
}

/// One flattened routing entry (host + path → service:port) for display.
struct IngressRoute: Hashable {
    let host: String
    let path: String
    let service: String
    let port: String
}

extension Ingress {
    var className: String { spec?.ingressClassName ?? "—" }

    var isTLS: Bool { !(spec?.tls?.isEmpty ?? true) }

    var hosts: [String] {
        Array(Set((spec?.rules ?? []).compactMap { $0.host })).sorted()
    }

    /// External address(es) assigned by the ingress controller's load balancer.
    var address: String? {
        let parts = (status?.loadBalancer?.ingress ?? []).compactMap { $0.ip ?? $0.hostname }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// Flattened (host, path, service, port) rows, including a default backend if set.
    var routes: [IngressRoute] {
        var out: [IngressRoute] = []
        for rule in spec?.rules ?? [] {
            for p in rule.http?.paths ?? [] {
                out.append(IngressRoute(
                    host: rule.host ?? "*",
                    path: p.path ?? "/",
                    service: p.backend.service?.name ?? "—",
                    port: Self.portLabel(p.backend.service?.port)
                ))
            }
        }
        if let def = spec?.defaultBackend?.service {
            out.append(IngressRoute(host: "*", path: "/", service: def.name, port: Self.portLabel(def.port)))
        }
        return out
    }

    static func portLabel(_ port: ServicePort?) -> String {
        if let n = port?.number { return String(n) }
        return port?.name ?? ""
    }
}

struct Service: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let spec: Spec?
    let status: Status?
    var id: String { metadata.uid }

    struct Spec: Codable, Hashable {
        let type: String?                 // ClusterIP | NodePort | LoadBalancer | ExternalName
        let clusterIP: String?
        let selector: [String: String]?
        let ports: [Port]?
        let externalName: String?
        let externalIPs: [String]?
    }

    struct Port: Codable, Hashable {
        let name: String?
        let port: Int
        let targetPort: AnyKubeIntOrString?
        let `protocol`: String?
        let nodePort: Int?
    }

    struct Status: Codable, Hashable {
        let loadBalancer: LoadBalancer?
    }

    struct LoadBalancer: Codable, Hashable {
        let ingress: [LBEntry]?
    }

    struct LBEntry: Codable, Hashable {
        let ip: String?
        let hostname: String?
    }
}

struct Namespace: Codable, Identifiable, Hashable {
    let metadata: ObjectMeta
    let status: Status?
    var id: String { metadata.uid }

    struct Status: Codable, Hashable {
        let phase: String?   // Active | Terminating
    }

    var phase: String { status?.phase ?? "Active" }
}

struct ContainerResourceSummary: Hashable {
    let containerName: String
    let image: String?
    let cpuRequest: String?
    let cpuLimit: String?
    let memRequest: String?
    let memLimit: String?
    let ports: [Int]
}

extension Deployment {
    /// Per-container resource + image summary, suitable for inline display.
    var containerSummaries: [ContainerResourceSummary] {
        let containers = spec?.template?.spec?.containers ?? []
        return containers.map { c in
            ContainerResourceSummary(
                containerName: c.name,
                image: c.image,
                cpuRequest: c.resources?.requests?["cpu"],
                cpuLimit: c.resources?.limits?["cpu"],
                memRequest: c.resources?.requests?["memory"],
                memLimit: c.resources?.limits?["memory"],
                ports: (c.ports ?? []).map(\.containerPort)
            )
        }
    }

    /// Compact `RollingUpdate (maxSurge 25%, maxUnavailable 25%)` style line.
    var strategyDescription: String {
        let t = spec?.strategy?.type ?? "RollingUpdate"
        guard let ru = spec?.strategy?.rollingUpdate else { return t }
        let ms = ru.maxSurge?.stringValue ?? "25%"
        let mu = ru.maxUnavailable?.stringValue ?? "25%"
        return "\(t) · maxSurge \(ms) · maxUnavailable \(mu)"
    }
}

extension Deployment {
    /// Build a kubectl label-selector argument from matchLabels.
    /// Returns e.g. "app=fieldnotes,tier=web" (sorted alphabetically by key for determinism).
    /// Empty string if no matchLabels.
    var labelSelector: String {
        let pairs = spec?.selector?.matchLabels ?? [:]
        return pairs.sorted(by: { $0.key < $1.key })
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: ",")
    }
}
