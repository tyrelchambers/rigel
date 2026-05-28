import SwiftUI

/// A resource candidate shown in the @-mention popover.
struct MentionCandidate: Identifiable {
    enum Kind { case pod, deployment, node }
    let id: String
    let kind: Kind
    let name: String
    let namespace: String?
    /// One-line summary appended to the prompt when this candidate is picked.
    /// Gives Claude inline context so it doesn't need to re-fetch.
    let contextSummary: String

    var iconName: String {
        switch kind {
        case .pod:        return "shippingbox.fill"
        case .deployment: return "square.stack.3d.up.fill"
        case .node:       return "server.rack"
        }
    }
    var kindLabel: String {
        switch kind { case .pod: return "POD"; case .deployment: return "DEPLOY"; case .node: return "NODE" }
    }
}

enum MentionIndex {
    /// Build the candidate list. Sorted by kind (deployments first since they're
    /// what you usually ask about), then alphabetically.
    static func build(from cache: ClusterCache) -> [MentionCandidate] {
        var out: [MentionCandidate] = []

        for d in cache.deployments {
            let ready = d.status?.readyReplicas ?? 0
            let desired = d.spec?.replicas ?? d.status?.replicas ?? 0
            let image = d.spec?.template?.spec?.containers.first?.image ?? "—"
            out.append(MentionCandidate(
                id: "dep-\(d.metadata.uid)",
                kind: .deployment,
                name: d.metadata.name,
                namespace: d.metadata.namespace,
                contextSummary: "Deployment \(d.metadata.name) in \(d.metadata.namespace ?? "default"): \(ready)/\(desired) ready, image \(image)"
            ))
        }
        for p in cache.pods {
            let phase = p.status?.phase ?? "?"
            let restarts = (p.status?.containerStatuses ?? []).map(\.restartCount).reduce(0, +)
            let badState = (p.status?.containerStatuses ?? []).compactMap { $0.state?.waiting?.reason }.first
            let stateBit = badState.map { " (\($0))" } ?? ""
            out.append(MentionCandidate(
                id: "pod-\(p.metadata.uid)",
                kind: .pod,
                name: p.metadata.name,
                namespace: p.metadata.namespace,
                contextSummary: "Pod \(p.metadata.name) in \(p.metadata.namespace ?? "default"): phase \(phase)\(stateBit), restarts \(restarts), node \(p.spec?.nodeName ?? "?")"
            ))
        }
        for n in cache.nodes {
            let ready = n.isReady ? "Ready" : "NotReady"
            out.append(MentionCandidate(
                id: "node-\(n.metadata.uid)",
                kind: .node,
                name: n.metadata.name,
                namespace: nil,
                contextSummary: "Node \(n.metadata.name): \(ready), role \(n.role)"
            ))
        }

        return out
    }

    /// Filter candidates by substring (case-insensitive on name + namespace),
    /// and rank: deployment exact > pod exact > prefix > substring.
    static func filter(_ candidates: [MentionCandidate], query: String, limit: Int = 8) -> [MentionCandidate] {
        let q = query.lowercased()
        guard !q.isEmpty else {
            // No query → show deployments first since they're highest-signal.
            return Array(candidates.sorted {
                if $0.kind == $1.kind { return $0.name < $1.name }
                return rank($0.kind) < rank($1.kind)
            }.prefix(limit))
        }
        struct Scored { let c: MentionCandidate; let score: Int }
        var scored: [Scored] = []
        for c in candidates {
            let name = c.name.lowercased()
            let ns = (c.namespace ?? "").lowercased()
            var best = -1
            if name == q { best = 1000 }
            else if name.hasPrefix(q) { best = 500 }
            else if let r = name.range(of: q) { best = 200 - name.distance(from: name.startIndex, to: r.lowerBound) }
            else if ns.contains(q) { best = 50 }
            if best >= 0 {
                // Boost deployments
                let kindBoost = c.kind == .deployment ? 20 : 0
                scored.append(Scored(c: c, score: best + kindBoost))
            }
        }
        scored.sort { $0.score > $1.score }
        return Array(scored.prefix(limit).map(\.c))
    }

    private static func rank(_ k: MentionCandidate.Kind) -> Int {
        switch k { case .deployment: return 0; case .pod: return 1; case .node: return 2 }
    }
}

/// Popover view rendered above the chat input when an active `@query` is typed.
struct MentionPopover: View {
    let candidates: [MentionCandidate]
    let selectedIndex: Int
    let onPick: (MentionCandidate) -> Void

    var body: some View {
        if candidates.isEmpty {
            EmptyView()
        } else {
            VStack(spacing: 1) {
                ForEach(Array(candidates.enumerated()), id: \.element.id) { idx, c in
                    row(c, isSelected: idx == selectedIndex)
                }
            }
            .padding(4)
            .background(Theme.Surface.elevated)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .strokeBorder(Theme.Border.strong, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            .shadow(color: .black.opacity(0.4), radius: 12, y: 4)
        }
    }

    private func row(_ c: MentionCandidate, isSelected: Bool) -> some View {
        Button { onPick(c) } label: {
            HStack(spacing: 8) {
                Image(systemName: c.iconName)
                    .font(.system(size: 10))
                    .foregroundStyle(isSelected ? Theme.Foreground.inverse : Theme.Foreground.secondary)
                    .frame(width: 14)
                Text(c.name)
                    .font(Theme.Font.mono(12, weight: .medium))
                    .foregroundStyle(isSelected ? Theme.Foreground.inverse : Theme.Foreground.primary)
                    .lineLimit(1)
                if let ns = c.namespace {
                    Text(ns)
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(isSelected ? Theme.Foreground.inverse.opacity(0.7) : Theme.Foreground.tertiary)
                        .lineLimit(1)
                }
                Spacer()
                Text(c.kindLabel)
                    .font(Theme.Font.mono(9, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(isSelected ? Theme.Foreground.inverse.opacity(0.7) : Theme.Foreground.tertiary)
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(isSelected ? Theme.Accent.primary : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }
}
