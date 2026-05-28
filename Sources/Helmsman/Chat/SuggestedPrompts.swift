import SwiftUI

/// One chip in the suggested-prompts row above the chat input.
struct SuggestedPrompt: Identifiable {
    let id: String
    let label: String
    let icon: String
    let tint: Color
    /// The full prompt sent to Claude when the chip fires. Built with resource
    /// context inline so Claude doesn't have to re-query just to know what
    /// the user is asking about.
    let prompt: String
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

        // 3. Recent warning events surge (any cluster warnings in the last few minutes)
        let recentWarnings = cache.events.filter { $0.isWarning }.prefix(20)
        if recentWarnings.count >= 3 {
            out.append(SuggestedPrompt(
                id: "warnings-\(recentWarnings.count)",
                label: "\(recentWarnings.count) warning events — what's wrong?",
                icon: "exclamationmark.bubble.fill",
                tint: Theme.Status.failed,
                prompt: """
                The cluster has \(recentWarnings.count) recent Warning-level events. Look at them, group by root cause, and tell me what needs attention.
                """
            ))
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
