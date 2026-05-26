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
