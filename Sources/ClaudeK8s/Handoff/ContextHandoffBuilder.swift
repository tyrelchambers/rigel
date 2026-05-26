import Foundation

enum ContextHandoffBuilder {
    static func build(_ selection: PanelSelection) -> String {
        switch selection {
        case .pod(let pod, let describe, let events):
            let phase = pod.status?.phase ?? "Unknown"
            let containerStatuses = pod.status?.containerStatuses ?? []
            let restarts = containerStatuses.map(\.restartCount).reduce(0, +)
            let containerSummary = containerStatuses.map { cs -> String in
                var stateDesc = "unknown"
                if let w = cs.state?.waiting {
                    stateDesc = "waiting(\(w.reason ?? "unknown"))"
                } else if cs.state?.running != nil {
                    stateDesc = "running"
                } else if let t = cs.state?.terminated {
                    stateDesc = "terminated(\(t.reason ?? "unknown"), exit \(t.exitCode.map(String.init) ?? "?"))"
                }
                return "\(cs.name): \(stateDesc), restarts=\(cs.restartCount)"
            }.joined(separator: "; ")

            return """
            Pod **\(pod.metadata.name)** in namespace **\(pod.metadata.namespace ?? "default")** is in phase \(phase) on node \(pod.spec?.nodeName ?? "?") with \(restarts) restart(s).

            Containers: \(containerSummary.isEmpty ? "none" : containerSummary)

            What's wrong with it, and what should I do? Look at the data below first; ask me to run more commands if you need additional context.

            kubectl describe pod/\(pod.metadata.name) -n \(pod.metadata.namespace ?? "default"):
            ```
            \(describe)
            ```

            kubectl get events -n \(pod.metadata.namespace ?? "default") --field-selector involvedObject.name=\(pod.metadata.name):
            ```
            \(events)
            ```
            """
        }
    }
}
