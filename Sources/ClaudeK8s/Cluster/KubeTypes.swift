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
