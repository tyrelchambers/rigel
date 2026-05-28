import SwiftUI

/// Visual, at-a-glance representation of a parsed `ManifestSummary`: what
/// workloads land, their images/tags/resources, then the services and
/// ingresses that expose them. Shown on the wizard's generate step in place
/// of raw YAML.
struct ManifestSummaryView: View {
    let summary: ManifestSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if !summary.workloads.isEmpty {
                Section(title: "WORKLOADS", systemImage: "shippingbox.fill") {
                    ForEach(summary.workloads) { WorkloadCard(workload: $0) }
                }
            }
            if !summary.services.isEmpty {
                Section(title: "SERVICES", systemImage: "network") {
                    ForEach(summary.services) { ServiceCard(service: $0) }
                }
            }
            if !summary.ingresses.isEmpty {
                Section(title: "INGRESS", systemImage: "globe") {
                    ForEach(summary.ingresses) { IngressCard(ingress: $0) }
                }
            }
            if !summary.volumes.isEmpty {
                Section(title: "STORAGE", systemImage: "internaldrive.fill") {
                    ForEach(summary.volumes) { VolumeCard(volume: $0) }
                }
            }
            if !summary.configs.isEmpty {
                Section(title: "CONFIG", systemImage: "doc.text.fill") {
                    ForEach(summary.configs) { ConfigCard(config: $0) }
                }
            }
            if !summary.others.isEmpty {
                Section(title: "OTHER", systemImage: "cube") {
                    ForEach(summary.others) { OtherRow(resource: $0) }
                }
            }
        }
    }
}

// MARK: - Section scaffold

private struct Section<Content: View>: View {
    let title: String
    let systemImage: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.system(size: 9))
                    .foregroundStyle(Theme.Foreground.tertiary)
                Text(title)
                    .font(Theme.Font.mono(9, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .tracking(0.5)
            }
            content()
        }
    }
}

// MARK: - Workload

private struct WorkloadCard: View {
    let workload: WorkloadSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                KindBadge(text: workload.kind)
                Text(workload.name)
                    .font(Theme.Font.mono(12, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Spacer()
                if let replicas = workload.replicas {
                    MetaChip(icon: "square.stack.3d.up.fill", text: "\(replicas) replica\(replicas == 1 ? "" : "s")")
                }
                if let pin = workload.nodePin {
                    MetaChip(icon: "pin.fill", text: pin, tint: Theme.Accent.primary)
                }
            }

            if !workload.labels.isEmpty {
                LabelChips(labels: workload.labels)
            }

            ForEach(workload.containers) { ContainerRow(container: $0) }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardChrome()
    }
}

private struct ContainerRow: View {
    let container: ContainerSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "cube.box.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(Theme.Foreground.tertiary)
                Text(container.name)
                    .font(Theme.Font.mono(10, weight: .medium))
                    .foregroundStyle(Theme.Foreground.secondary)
                Spacer()
                ForEach(container.ports, id: \.self) { port in
                    MetaChip(icon: "bolt.horizontal.fill", text: ":\(port)")
                }
            }

            // Image with the tag called out in the accent color.
            HStack(spacing: 0) {
                Text(container.imageParts.repo)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.primary)
                Text(":")
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
                Text(container.imageParts.tag)
                    .font(Theme.Font.mono(11, weight: .semibold))
                    .foregroundStyle(Theme.Accent.primary)
            }
            .textSelection(.enabled)
            .lineLimit(1)
            .truncationMode(.middle)

            HStack(spacing: 14) {
                ResourceStat(label: "CPU", request: container.cpuRequest, limit: container.cpuLimit)
                ResourceStat(label: "MEM", request: container.memRequest, limit: container.memLimit)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.sunken)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

private struct ResourceStat: View {
    let label: String
    let request: String?
    let limit: String?

    var body: some View {
        HStack(spacing: 5) {
            Text(label)
                .font(Theme.Font.mono(8, weight: .semibold))
                .foregroundStyle(Theme.Foreground.tertiary)
                .tracking(0.5)
            Text(value)
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(request == nil && limit == nil ? Theme.Foreground.tertiary : Theme.Foreground.primary)
        }
    }

    private var value: String {
        switch (request, limit) {
        case let (r?, l?) where r == l: return r
        case let (r?, l?):              return "\(r) → \(l)"
        case let (r?, nil):             return r
        case let (nil, l?):             return "→ \(l)"
        case (nil, nil):                return "unset"
        }
    }
}

// MARK: - Service

private struct ServiceCard: View {
    let service: ServiceSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                KindBadge(text: service.type)
                Text(service.name)
                    .font(Theme.Font.mono(12, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Spacer()
            }
            if service.ports.isEmpty {
                Text("no ports declared")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            } else {
                ForEach(service.ports) { port in
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.right")
                            .font(.system(size: 8))
                            .foregroundStyle(Theme.Foreground.tertiary)
                        Text(portLine(port))
                            .font(Theme.Font.mono(10))
                            .foregroundStyle(Theme.Foreground.secondary)
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardChrome()
    }

    private func portLine(_ p: PortMapping) -> String {
        var s = "\(p.port)"
        if let target = p.targetPort { s += " → \(target)" }
        if let proto = p.proto, proto != "TCP" { s += " (\(proto))" }
        return s
    }
}

// MARK: - Ingress

private struct IngressCard: View {
    let ingress: IngressSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(ingress.name)
                    .font(Theme.Font.mono(12, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Spacer()
                if ingress.tls {
                    MetaChip(icon: "lock.fill", text: "TLS", tint: Theme.Status.running)
                }
            }
            ForEach(ingress.rules) { rule in
                VStack(alignment: .leading, spacing: 4) {
                    if let host = rule.host {
                        HStack(spacing: 5) {
                            Image(systemName: "globe")
                                .font(.system(size: 9))
                                .foregroundStyle(Theme.Accent.primary)
                            Text(host)
                                .font(Theme.Font.mono(11, weight: .medium))
                                .foregroundStyle(Theme.Accent.primary)
                                .textSelection(.enabled)
                        }
                    }
                    ForEach(rule.paths) { path in
                        HStack(spacing: 6) {
                            Text(path.path)
                                .font(Theme.Font.mono(10))
                                .foregroundStyle(Theme.Foreground.secondary)
                            Image(systemName: "arrow.right")
                                .font(.system(size: 8))
                                .foregroundStyle(Theme.Foreground.tertiary)
                            Text(backend(path))
                                .font(Theme.Font.mono(10))
                                .foregroundStyle(Theme.Foreground.secondary)
                        }
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardChrome()
    }

    private func backend(_ p: IngressPath) -> String {
        let svc = p.service ?? "?"
        if let port = p.port { return "\(svc):\(port)" }
        return svc
    }
}

// MARK: - Storage / Config / Other

private struct VolumeCard: View {
    let volume: VolumeSummary

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "internaldrive.fill")
                .font(.system(size: 12))
                .foregroundStyle(Theme.Foreground.tertiary)
            VStack(alignment: .leading, spacing: 2) {
                Text(volume.name)
                    .font(Theme.Font.mono(11, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text(detail)
                    .font(Theme.Font.mono(9))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            Spacer()
            if let size = volume.size {
                MetaChip(icon: "externaldrive.fill", text: size)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardChrome()
    }

    private var detail: String {
        var parts = volume.accessModes
        if let sc = volume.storageClass { parts.append("class: \(sc)") }
        return parts.isEmpty ? "PersistentVolumeClaim" : parts.joined(separator: " · ")
    }
}

private struct ConfigCard: View {
    let config: ConfigSummary

    var body: some View {
        HStack(spacing: 10) {
            KindBadge(text: config.kind)
            Text(config.name)
                .font(Theme.Font.mono(11, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Spacer()
            Text("\(config.keyCount) key\(config.keyCount == 1 ? "" : "s")")
                .font(Theme.Font.mono(9))
                .foregroundStyle(Theme.Foreground.tertiary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardChrome()
    }
}

private struct OtherRow: View {
    let resource: OtherResource

    var body: some View {
        HStack(spacing: 10) {
            KindBadge(text: resource.kind)
            Text(resource.name)
                .font(Theme.Font.mono(11, weight: .medium))
                .foregroundStyle(Theme.Foreground.secondary)
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardChrome()
    }
}

// MARK: - Shared chrome

private struct KindBadge: View {
    let text: String
    var body: some View {
        Text(text)
            .font(Theme.Font.mono(9, weight: .semibold))
            .foregroundStyle(Theme.Accent.primary)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Theme.Accent.primaryDim)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

private struct MetaChip: View {
    let icon: String
    let text: String
    var tint: Color = Theme.Foreground.secondary

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: icon).font(.system(size: 8))
            Text(text).font(Theme.Font.mono(9, weight: .medium))
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(Theme.Surface.sunken)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

private struct LabelChips: View {
    let labels: [String: String]

    var body: some View {
        let sorted = labels.sorted { $0.key < $1.key }
        FlexWrap(spacing: 4, lineSpacing: 4) {
            ForEach(sorted, id: \.key) { key, value in
                HStack(spacing: 0) {
                    Text(shortKey(key))
                        .foregroundStyle(Theme.Foreground.tertiary)
                    Text("=")
                        .foregroundStyle(Theme.Foreground.tertiary)
                    Text(value)
                        .foregroundStyle(Theme.Foreground.secondary)
                }
                .font(Theme.Font.mono(9))
                .padding(.horizontal, 5).padding(.vertical, 2)
                .background(Theme.Surface.sunken)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
        }
    }

    /// Drop the common `app.kubernetes.io/` prefix so chips stay readable.
    private func shortKey(_ key: String) -> String {
        key.replacingOccurrences(of: "app.kubernetes.io/", with: "")
    }
}

/// Wrapping flow layout for chips that may overflow one line.
private struct FlexWrap: Layout {
    var spacing: CGFloat
    var lineSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var lineHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

private extension View {
    func cardChrome() -> some View {
        background(Theme.Surface.elevated)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(Theme.Border.subtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}
