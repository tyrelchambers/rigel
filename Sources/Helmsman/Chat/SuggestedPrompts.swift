import SwiftUI

/// One chip in the suggested-prompts row above the chat input.
struct SuggestedPrompt: Identifiable, Equatable {
    let id: String
    let label: String
    let icon: String
    let tint: Color
    /// The full prompt sent to Claude when the chip fires. Built with resource
    /// context inline so Claude doesn't have to re-query just to know what
    /// the user is asking about.
    let prompt: String

    /// Identity-based equality so the chat can skip redraws when a periodic
    /// refresh produces the same chips.
    static func == (a: SuggestedPrompt, b: SuggestedPrompt) -> Bool {
        a.id == b.id && a.label == b.label && a.prompt == b.prompt
    }
}

/// A bucket of warning events sharing the same root signature — reason +
/// involved-object kind + namespace — so a chip names the actual problem
/// ("9× snapshot becomes not ready") instead of a bare count.
struct WarningGroup {
    let reason: String
    let kind: String
    let namespace: String
    /// Total occurrences (summing each event's server-side `count`).
    let total: Int
    /// Most common message within the group, used for the label + prompt.
    let sampleMessage: String
    /// Distinct involved-object names, in first-seen order.
    let objectNames: [String]

    var signature: String { "\(reason)|\(kind)|\(namespace)" }

    /// Short chip label: the compacted message when present, else the reason.
    var shortLabel: String {
        let base = sampleMessage.isEmpty ? reason : sampleMessage
        return base.count > 44 ? String(base.prefix(44)) + "…" : base
    }

    var prompt: String {
        let names = objectNames.prefix(8).joined(separator: ", ")
        let more = objectNames.count > 8 ? " (+\(objectNames.count - 8) more)" : ""
        let affected = names.isEmpty ? "" : "\nAffected \(kind): \(names)\(more)"
        return """
        \(total) Warning event\(total == 1 ? "" : "s") in namespace **\(namespace)** — reason **\(reason)** on \(kind) resources.
        Message: "\(sampleMessage)"\(affected)

        Investigate the root cause and tell me what needs attention and how to fix it.
        """
    }
}

/// Builds the chip list from current ClusterCache state. Priority order:
/// unhealthy pods > degraded deployments > recent warning events > always-on
/// "Investigate cluster" fallback. Capped at ~8 chips so the row stays scannable.
enum SuggestedPromptsBuilder {
    static func build(cache: ClusterCache, contextName: String?) -> [SuggestedPrompt] {
        var out: [SuggestedPrompt] = []

        // 1. Unhealthy pods (crashloop, image pull failures, failed phase)
        for pod in unhealthyPods(cache.pods).prefix(3) {
            let reason = podBadStateLabel(pod)
            out.append(SuggestedPrompt(
                id: "pod-\(pod.metadata.uid)",
                label: "Why is \(pod.metadata.name) \(reason.lowercased())?",
                icon: "exclamationmark.triangle.fill",
                tint: Theme.Status.failed,
                prompt: """
                Pod **\(pod.metadata.name)** in namespace **\(pod.metadata.namespace ?? "default")** is in \(reason).
                Restarts: \(totalRestarts(pod)). Node: \(pod.spec?.nodeName ?? "?").

                Investigate why. Run kubectl describe + logs + events as needed. Be specific about the root cause and what to do.
                """
            ))
        }

        // 2. Degraded deployments (ready < desired)
        for dep in degradedDeployments(cache.deployments).prefix(3) {
            let ready = dep.status?.readyReplicas ?? 0
            let desired = dep.spec?.replicas ?? dep.status?.replicas ?? 0
            out.append(SuggestedPrompt(
                id: "dep-\(dep.metadata.uid)",
                label: "Why is \(dep.metadata.name) degraded?",
                icon: "square.stack.3d.up.fill",
                tint: Theme.Status.pending,
                prompt: """
                Deployment **\(dep.metadata.name)** in namespace **\(dep.metadata.namespace ?? "default")** is degraded — \(ready)/\(desired) replicas ready.

                Investigate why pods aren't coming up. Check rollout status, pod events, recent template changes. Be specific.
                """
            ))
        }

        // 3. Recent warning events, grouped by (reason, kind, namespace) so each
        //    chip names the actual problem instead of a bare count. Surface the
        //    top groups by occurrence once there's a meaningful surge.
        let warnings = cache.events.filter { $0.isWarning }
        if warnings.count >= 3 {
            for group in groupWarnings(warnings).prefix(3) {
                out.append(SuggestedPrompt(
                    id: "warn-\(group.signature)",
                    label: "\(group.total)× \(group.shortLabel)",
                    icon: "exclamationmark.bubble.fill",
                    tint: Theme.Status.failed,
                    prompt: group.prompt
                ))
            }
        }

        // 4. Pressure conditions on any node
        for node in cache.nodes where hasPressure(node) {
            out.append(SuggestedPrompt(
                id: "node-\(node.metadata.uid)",
                label: "\(node.metadata.name): node pressure",
                icon: "server.rack",
                tint: Theme.Status.pending,
                prompt: """
                Node **\(node.metadata.name)** is reporting pressure conditions. Look at its status and recent events, identify the cause, and tell me how to relieve it.
                """
            ))
            if out.count >= 6 { break }
        }

        // 5. Always-on fallback
        out.append(SuggestedPrompt(
            id: "investigate",
            label: "Investigate cluster",
            icon: "sparkles",
            tint: Theme.Accent.primary,
            prompt: """
            Investigate the cluster's current health. Run kubectl read-only commands across nodes, pods, recent events, deployment status, and CNPG cluster health. Identify anything broken, broken-soon, or unusual.

            Be concise. Group findings by severity. If everything looks fine, say so briefly.
            """
        ))

        return Array(out.prefix(8))
    }

    // MARK: - Warning grouping

    /// Bucket warning events by (reason, involved-kind, namespace), summing
    /// server-side counts and collecting the affected object names. Sorted by
    /// total occurrences, descending. Internal so it can be unit-tested.
    static func groupWarnings(_ events: [K8sEvent]) -> [WarningGroup] {
        struct Acc {
            var total = 0
            var messageCounts: [String: Int] = [:]
            var names: [String] = []
            var seenNames = Set<String>()
        }
        var buckets: [String: Acc] = [:]
        var order: [String] = []
        var meta: [String: (reason: String, kind: String, ns: String)] = [:]

        for e in events {
            let reason = e.reason ?? "Warning"
            let kind = e.involvedObject?.kind ?? "Resource"
            let ns = e.involvedObject?.namespace ?? "default"
            let key = "\(reason)|\(kind)|\(ns)"
            if buckets[key] == nil {
                buckets[key] = Acc()
                order.append(key)
                meta[key] = (reason, kind, ns)
            }
            let occurrences = max(1, e.count ?? 1)
            buckets[key]!.total += occurrences
            let msg = compactMessage(e.message ?? "")
            if !msg.isEmpty { buckets[key]!.messageCounts[msg, default: 0] += occurrences }
            if let name = e.involvedObject?.name, buckets[key]!.seenNames.insert(name).inserted {
                buckets[key]!.names.append(name)
            }
        }

        return order.map { key in
            let acc = buckets[key]!
            let m = meta[key]!
            let sample = acc.messageCounts.max { $0.value < $1.value }?.key ?? ""
            return WarningGroup(
                reason: m.reason, kind: m.kind, namespace: m.ns,
                total: acc.total, sampleMessage: sample, objectNames: acc.names
            )
        }
        .sorted { $0.total > $1.total }
    }

    /// Normalize a message for grouping/labels: drop the k8s "(combined from
    /// similar events): " prefix and collapse whitespace.
    private static func compactMessage(_ s: String) -> String {
        var m = s
        if let r = m.range(of: "(combined from similar events): ") { m.removeSubrange(r) }
        return m.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    // MARK: - Helpers

    private static func unhealthyPods(_ pods: [Pod]) -> [Pod] {
        pods.filter { $0.errorReason != nil }
            .sorted { totalRestarts($0) > totalRestarts($1) }
    }

    private static func degradedDeployments(_ deps: [Deployment]) -> [Deployment] {
        deps.filter { d in
            let ready = d.status?.readyReplicas ?? 0
            let desired = d.spec?.replicas ?? d.status?.replicas ?? 0
            return desired > 0 && ready < desired
        }
        .sorted { lhs, rhs in
            // Larger gaps first
            let lg = (lhs.spec?.replicas ?? 0) - (lhs.status?.readyReplicas ?? 0)
            let rg = (rhs.spec?.replicas ?? 0) - (rhs.status?.readyReplicas ?? 0)
            return lg > rg
        }
    }

    private static func hasPressure(_ node: Node) -> Bool {
        (node.status?.conditions ?? []).contains { $0.type != "Ready" && $0.status == "True" }
    }

    private static func podBadStateLabel(_ pod: Pod) -> String {
        pod.errorReason ?? "unhealthy"
    }

    private static func totalRestarts(_ pod: Pod) -> Int {
        (pod.status?.containerStatuses ?? []).map(\.restartCount).reduce(0, +)
    }
}

/// Horizontal chip row rendered above the chat input.
struct SuggestedPromptsRow: View {
    let prompts: [SuggestedPrompt]
    let onTap: (SuggestedPrompt) -> Void

    var body: some View {
        if prompts.isEmpty {
            EmptyView()
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(prompts) { prompt in
                        chip(prompt)
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 6)
            }
            .background(Theme.Surface.elevated)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Theme.Border.subtle).frame(height: 1)
            }
        }
    }

    private func chip(_ prompt: SuggestedPrompt) -> some View {
        Button { onTap(prompt) } label: {
            HStack(spacing: 5) {
                Image(systemName: prompt.icon)
                    .font(.system(size: 9))
                Text(prompt.label)
                    .font(Theme.Font.body(11, weight: .medium))
                    .lineLimit(1)
            }
            .foregroundStyle(prompt.tint)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(prompt.tint.opacity(0.12))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(prompt.tint.opacity(0.3), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
        .help(prompt.prompt.prefix(200).description)
    }
}
