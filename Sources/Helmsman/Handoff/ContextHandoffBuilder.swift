import Foundation

enum ContextHandoffBuilder {
    static func build(_ selection: PanelSelection) -> String {
        switch selection {
        case .pod(let pod, let action, let describe, let events, let logs):
            return buildPod(pod, action: action, describe: describe, events: events, logs: logs)
        case .deployment(let dep, let action, let pods, let describe, let perPodLogs, let rollout):
            return buildDeployment(dep, action: action, pods: pods, describe: describe, perPodLogs: perPodLogs, rollout: rollout)
        case .logSlice(let target, let surrounding):
            return buildLogSlice(target: target, surrounding: surrounding)
        case .event(let event, let related):
            return buildEvent(event, related: related)
        }
    }

    // MARK: - Event

    private static func buildEvent(_ event: K8sEvent, related: [K8sEvent]) -> String {
        let target = [event.involvedObject?.kind, event.involvedObject?.name].compactMap { $0 }.joined(separator: "/")
        let ns = event.involvedObject?.namespace ?? "default"
        let relatedBlock = related.isEmpty ? "" : """

        Related events on the same object:
        \(related.map { "- [\($0.type ?? "—")] \($0.reason ?? "—"): \($0.message ?? "")" }.joined(separator: "\n"))
        """
        return """
        Event **[\(event.type ?? "?")] \(event.reason ?? "?")** on \(target) (namespace \(ns)).

        Message: \(event.message ?? "(none)")
        Count: \(event.count ?? 1) · last seen: \(event.when?.formatted() ?? "?")

        Investigate this event. Is it a one-off or part of a pattern? What action (if any) should I take? Use kubectl read-only commands to gather more context if needed.
        \(relatedBlock)
        """
    }

    // MARK: - Pod

    private static func buildPod(_ pod: Pod, action: PodAction, describe: String, events: String, logs: String?) -> String {
        let ns = pod.metadata.namespace ?? "default"
        let header = podHeader(pod)
        let describeBlock = """
        kubectl describe pod/\(pod.metadata.name) -n \(ns):
        ```
        \(describe)
        ```
        """
        let eventsBlock = """
        kubectl get events -n \(ns) --field-selector involvedObject.name=\(pod.metadata.name):
        ```
        \(events)
        ```
        """
        let logsBlock = logs.map { """
        kubectl logs \(pod.metadata.name) -n \(ns) --tail=200 --all-containers=true:
        ```
        \($0)
        ```
        """ } ?? ""

        switch action {
        case .errors:
            return """
            \(header)

            Investigate any errors with this pod. Look for crash loops, OOM kills, failing probes, image pull failures, or repeated restarts. Use the data below; ask for more if needed.

            \(describeBlock)

            \(eventsBlock)

            \(logsBlock)
            """
        case .logs:
            return """
            \(header)

            Skim the recent logs for this pod and surface anything notable — errors, warnings, spikes, or unusual patterns. Don't summarize every line.

            \(logsBlock.isEmpty ? "(no logs captured)" : logsBlock)
            """
        case .explain:
            return """
            \(header)

            Explain what this pod is doing in plain English. Cover: its purpose (from labels/owner), current state, how long it's been running, and anything noteworthy in its config.

            \(describeBlock)
            """
        case .whyNotReady:
            return """
            \(header)

            This pod is not ready. Tell me why and what to do about it. Check readiness/liveness probes, init containers, scheduling, image pulls, and resource limits.

            \(describeBlock)

            \(eventsBlock)
            """
        }
    }

    private static func podHeader(_ pod: Pod) -> String {
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
        """
    }

    // MARK: - Deployment

    private static func buildDeployment(_ dep: Deployment, action: DeploymentAction, pods: [Pod], describe: String, perPodLogs: [String: String]?, rollout: String?) -> String {
        let ns = dep.metadata.namespace ?? "default"
        let header = deploymentHeader(dep, pods: pods)
        let describeBlock = """
        kubectl describe deployment/\(dep.metadata.name) -n \(ns):
        ```
        \(describe)
        ```
        """
        let logsBlock = perPodLogs.map { aggregatePodLogs($0) } ?? ""
        let rolloutBlock = rollout.map { """
        kubectl rollout history + status for deployment/\(dep.metadata.name) -n \(ns):
        ```
        \($0)
        ```
        """ } ?? ""

        switch action {
        case .errors:
            return """
            \(header)

            Investigate errors across this deployment's pods. Are all pods failing the same way (systemic), or is one bad pod (replace it)? Look for crash loops, OOM kills, failing probes, image pull failures.

            \(describeBlock)

            \(logsBlock.isEmpty ? "(no pod logs captured)" : logsBlock)
            """
        case .logs:
            return """
            \(header)

            Skim recent logs across all pods in this deployment. Each block is prefixed with the pod name. Surface anything notable — errors, warnings, divergence between pods.

            \(logsBlock.isEmpty ? "(no pod logs captured)" : logsBlock)
            """
        case .explain:
            return """
            \(header)

            Explain what this deployment is doing in plain English. Cover: its purpose (from labels/image/command), current rollout state, replica health, and anything noteworthy in its config.

            \(describeBlock)
            """
        case .rollout:
            return """
            \(header)

            Analyze this deployment's rollout. Is it healthy, stalled, or recently changed? Diff revisions if relevant. Suggest next steps if something looks off.

            \(rolloutBlock.isEmpty ? "(no rollout data captured)" : rolloutBlock)

            \(describeBlock)
            """
        }
    }

    private static func deploymentHeader(_ dep: Deployment, pods: [Pod]) -> String {
        let ns = dep.metadata.namespace ?? "default"
        let replicas = "\(dep.status?.readyReplicas ?? 0)/\(dep.status?.replicas ?? 0) ready"
        let podSummary = pods.map { p -> String in
            let phase = p.status?.phase ?? "?"
            let restarts = p.status?.containerStatuses?.map(\.restartCount).reduce(0, +) ?? 0
            return "- \(p.metadata.name): \(phase), restarts=\(restarts), node=\(p.spec?.nodeName ?? "?")"
        }.joined(separator: "\n")

        return """
        Deployment **\(dep.metadata.name)** in namespace **\(ns)** — \(replicas).

        Pods owned by this deployment:
        \(podSummary.isEmpty ? "(none matched)" : podSummary)
        """
    }

    private static func aggregatePodLogs(_ perPodLogs: [String: String]) -> String {
        perPodLogs
            .sorted { $0.key < $1.key }
            .map { name, logs in
                """
                [\(name)]
                ```
                \(logs.isEmpty ? "(no logs)" : logs)
                ```
                """
            }
            .joined(separator: "\n\n")
    }

    // MARK: - Log slice

    private static func buildLogSlice(target: LogLine, surrounding: [LogLine]) -> String {
        let context = surrounding.map { l -> String in
            let ts = l.timestamp.map { "\($0.formatted(date: .omitted, time: .standard)) " } ?? ""
            let marker = (l.id == target.id) ? "→ " : "  "
            return "\(marker)\(ts)\(l.text)"
        }.joined(separator: "\n")
        return """
        From pod **\(target.sourcePod)** — log line marked with → is what I want to ask about:

        ```
        \(context)
        ```

        What's happening, and what should I do?
        """
    }
}
