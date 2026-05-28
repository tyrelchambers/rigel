import Foundation

/// Capacity headroom for one node, in app-relative terms.
struct NodeFit: Hashable, Identifiable {
    let node: Node
    /// Free CPU after subtracting pending+running pod requests.
    let freeCPU: Double
    /// Free memory in bytes after subtracting pending+running pod requests.
    let freeMemoryBytes: Double
    /// Total allocatable CPU (cores) on the node.
    let allocatableCPU: Double
    /// Total allocatable memory (bytes) on the node.
    let allocatableMemoryBytes: Double
    /// True = the app's CPU AND memory requests fit on this node.
    let canHost: Bool
    /// True = `NoSchedule` (or `NoExecute`) taint excludes this node.
    let tainted: Bool
    /// True = node spec marks it unschedulable.
    let cordoned: Bool

    var id: String { node.id }

    /// True when the app can be pinned here: it fits and the node isn't
    /// tainted or cordoned. Same predicate used to rank nodes and to gate
    /// node-pin selection in the catalog UI.
    var eligible: Bool { canHost && !tainted && !cordoned }

    /// 0..1 — fraction of CPU+memory headroom remaining after the app's
    /// requests land. Used purely to sort nodes that all qualify.
    var headroomScore: Double {
        let cpuRatio = allocatableCPU > 0 ? max(0, freeCPU / allocatableCPU) : 0
        let memRatio = allocatableMemoryBytes > 0 ? max(0, freeMemoryBytes / allocatableMemoryBytes) : 0
        return (cpuRatio + memRatio) / 2.0
    }
}

/// Outcome of fitting one `CatalogApp` against current cluster state.
struct FitResult: Hashable {
    /// One entry per node, ordered so eligible (`canHost && !tainted && !cordoned`)
    /// nodes come first, sorted by `headroomScore` descending. Remaining
    /// nodes follow in arbitrary stable order.
    let perNode: [NodeFit]
    /// First eligible node, or nil when nothing fits.
    let recommended: NodeFit?

    var anyFits: Bool { recommended != nil }

    /// Cluster-wide categorical fit indicator for the catalog card dot.
    /// .green = at least one eligible node has >50% headroom remaining.
    /// .yellow = at least one eligible node fits but headroom is tight.
    /// .red = no eligible node fits.
    var dot: FitDot {
        guard let rec = recommended else { return .red }
        return rec.headroomScore >= 0.5 ? .green : .yellow
    }
}

enum FitDot: Hashable {
    case green, yellow, red
}

/// Compute per-node fit for an app against the live cluster state.
/// Pure — no side effects on the cache. Inputs are the app's requirements
/// plus snapshots of `nodes` and `pods` from `ClusterCache`.
func nodeFit(app: CatalogApp, nodes: [Node], pods: [Pod]) -> FitResult {
    let appCPU = ResourceQuantity.cpuCores(app.requirements.cpuRequest)
    let appMem = ResourceQuantity.bytes(app.requirements.memoryRequest)

    // Pre-aggregate pod requests by node name. Skip terminal pods so a node
    // with a recently-completed Job doesn't look saturated.
    var cpuUsedByNode: [String: Double] = [:]
    var memUsedByNode: [String: Double] = [:]
    for pod in pods {
        guard let nodeName = pod.spec?.nodeName else { continue }
        let phase = pod.status?.phase ?? ""
        if phase == "Succeeded" || phase == "Failed" { continue }
        for container in pod.spec?.containers ?? [] {
            if let cpu = container.resources?.requests?["cpu"] {
                cpuUsedByNode[nodeName, default: 0] += ResourceQuantity.cpuCores(cpu)
            }
            if let mem = container.resources?.requests?["memory"] {
                memUsedByNode[nodeName, default: 0] += ResourceQuantity.bytes(mem)
            }
        }
    }

    let fits: [NodeFit] = nodes.map { node in
        let name = node.metadata.name
        let allocCPU = ResourceQuantity.cpuCores(node.status?.allocatable?["cpu"] ?? "0")
        let allocMem = ResourceQuantity.bytes(node.status?.allocatable?["memory"] ?? "0")
        let freeCPU = max(0, allocCPU - (cpuUsedByNode[name] ?? 0))
        let freeMem = max(0, allocMem - (memUsedByNode[name] ?? 0))
        let tainted = (node.spec?.taints ?? []).contains { $0.effect == "NoSchedule" || $0.effect == "NoExecute" }
        let cordoned = node.spec?.unschedulable == true
        let canHost = freeCPU >= appCPU && freeMem >= appMem && node.isReady
        return NodeFit(
            node: node,
            freeCPU: freeCPU,
            freeMemoryBytes: freeMem,
            allocatableCPU: allocCPU,
            allocatableMemoryBytes: allocMem,
            canHost: canHost,
            tainted: tainted,
            cordoned: cordoned
        )
    }

    // Eligible = can host AND not tainted AND not cordoned. Sort eligible
    // first by headroom desc, then everything else trailing in name order
    // so the per-node list is deterministic for tests + UI.
    let eligible = fits
        .filter { $0.eligible }
        .sorted { $0.headroomScore > $1.headroomScore }
    let ineligible = fits
        .filter { !$0.eligible }
        .sorted { $0.node.metadata.name < $1.node.metadata.name }

    return FitResult(perNode: eligible + ineligible, recommended: eligible.first)
}
