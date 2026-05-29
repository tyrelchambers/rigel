import SwiftUI

/// Manage sheet for a single Service. Structured summary (type, clusterIP,
/// external address) + a control bar (Edit · Ask Claude · Delete · View YAML) +
/// a port list with one-click forward + live `kubectl describe`. Callbacks are
/// wired by MainWindow.
struct ServiceManageSheet: View {
    let service: Service
    let context: String?
    let onClose: () -> Void
    let onViewYAML: () -> Void
    let onEdit: (Service) -> Void
    let onDelete: (Service) -> Void
    let onAskClaude: (Service) -> Void
    let onForward: (Service, Service.Port) -> Void

    @State private var describe: String = ""
    @State private var isLoadingDescribe = true
    @State private var describeError: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    controlsBlock
                    summary
                    portsBlock
                    selectorBlock
                    describeBlock
                }
                .padding(16)
            }
            .background(Theme.Surface.sunken)
        }
        .frame(width: 760, height: 660)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.strong, lineWidth: 1)
        )
        .task { await loadDescribe() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "network")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Accent.primary)
            VStack(alignment: .leading, spacing: 2) {
                Text(service.metadata.name)
                    .font(Theme.Font.mono(15, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("Service · \(service.metadata.namespace ?? "default")")
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            Spacer()
            Button(action: onViewYAML) {
                HStack(spacing: 5) {
                    Image(systemName: "doc.text").font(.system(size: 10))
                    Text("YAML").font(Theme.Font.body(13, weight: .medium))
                }
                .foregroundStyle(Theme.Foreground.secondary)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Theme.Surface.sunken)
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.strong, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(width: 22, height: 22)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var controlsBlock: some View {
        HStack(spacing: 8) {
            actionButton(label: "Edit", icon: "pencil", tint: Theme.Accent.primary) { onEdit(service) }
            actionButton(label: "Ask Claude", icon: "bubble.left.and.bubble.right", tint: Theme.Accent.primary) { onAskClaude(service) }
            Spacer()
            actionButton(label: "Delete", icon: "trash", tint: Theme.Status.failed) { onDelete(service) }
        }
        .padding(12)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private func actionButton(label: String, icon: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 10))
                Text(label).font(Theme.Font.body(12, weight: .medium))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(tint.opacity(0.12))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(tint.opacity(0.3), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("DETAILS")
                .font(Theme.Font.body(11, weight: .semibold)).tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            kvRow("Type", service.typeLabel)
            if let ip = service.spec?.clusterIP, !ip.isEmpty {
                kvRow("ClusterIP", ip)
            }
            if let addr = service.externalAddress {
                kvRow("External", addr)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private func kvRow(_ key: String, _ value: String, color: Color? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(key)
                .font(Theme.Font.body(12, weight: .semibold)).tracking(0.3)
                .foregroundStyle(Theme.Foreground.tertiary).textCase(.uppercase)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(Theme.Font.mono(13))
                .foregroundStyle(color ?? Theme.Foreground.primary)
                .textSelection(.enabled).lineLimit(3).truncationMode(.middle)
            Spacer(minLength: 0)
        }
    }

    private var portsBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("PORTS (\(service.spec?.ports?.count ?? 0))")
                .font(Theme.Font.body(11, weight: .semibold)).tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            if (service.spec?.ports ?? []).isEmpty {
                Text("No ports")
                    .font(Theme.Font.mono(13)).foregroundStyle(Theme.Foreground.tertiary)
            } else {
                ForEach(service.spec?.ports ?? [], id: \.self) { port in
                    HStack(spacing: 8) {
                        if let name = port.name, !name.isEmpty {
                            Text(name).font(Theme.Font.mono(12, weight: .medium)).foregroundStyle(Theme.Foreground.primary)
                        }
                        Text(portDescription(port))
                            .font(Theme.Font.mono(11)).foregroundStyle(Theme.Accent.primary)
                        Spacer()
                        if !service.isExternalName {
                            Button { onForward(service, port) } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "arrow.left.arrow.right").font(.system(size: 9))
                                    Text("Forward").font(Theme.Font.body(11, weight: .medium))
                                }
                                .foregroundStyle(Theme.Accent.primary)
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(Theme.Accent.primary.opacity(0.12))
                                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(Theme.Surface.elevated)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
            }
        }
    }

    private func portDescription(_ p: Service.Port) -> String {
        let target = p.targetPort?.stringValue
        let arrow = (target != nil && target != String(p.port)) ? "→\(target!)" : ""
        let np = p.nodePort.map { " (nodePort \($0))" } ?? ""
        return "\(p.port)\(arrow)/\(p.protocol ?? "TCP")\(np)"
    }

    private var selectorBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("SELECTOR")
                .font(Theme.Font.body(11, weight: .semibold)).tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            let selector = service.spec?.selector ?? [:]
            if selector.isEmpty {
                Text("No selector (headless / externally managed endpoints)")
                    .font(Theme.Font.mono(13)).foregroundStyle(Theme.Foreground.tertiary)
            } else {
                ForEach(selector.sorted(by: { $0.key < $1.key }), id: \.key) { k, v in
                    Text("\(k) = \(v)")
                        .font(Theme.Font.mono(12)).foregroundStyle(Theme.Foreground.secondary)
                }
            }
        }
    }

    private var describeBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("KUBECTL DESCRIBE")
                    .font(Theme.Font.body(11, weight: .semibold)).tracking(0.5)
                    .foregroundStyle(Theme.Foreground.tertiary)
                if isLoadingDescribe { ProgressView().controlSize(.mini).tint(Theme.Accent.primary) }
                Spacer()
            }
            if let describeError {
                Text(describeError)
                    .font(Theme.Font.mono(13)).foregroundStyle(Theme.Status.failed)
                    .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Status.failed.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            } else if !describe.isEmpty {
                Text(describe)
                    .font(Theme.Font.mono(12)).foregroundStyle(Theme.Foreground.secondary)
                    .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10).background(Theme.Surface.elevated)
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
        }
    }

    private func loadDescribe() async {
        guard let kubectl = resolveBinary("kubectl") else {
            await MainActor.run { describeError = "kubectl not found"; isLoadingDescribe = false }
            return
        }
        var args: [String] = []
        if let context { args.append(contentsOf: ["--context", context]) }
        args.append(contentsOf: ["describe", "service", service.metadata.name])
        if let ns = service.metadata.namespace { args.append(contentsOf: ["-n", ns]) }
        do {
            let data = try await runProcess(kubectl, args: args)
            await MainActor.run {
                describe = String(data: data, encoding: .utf8) ?? ""
                isLoadingDescribe = false
            }
        } catch ProcessError.nonZeroExit(let code, let stderr) {
            await MainActor.run { describeError = "kubectl exited \(code):\n\(stderr)"; isLoadingDescribe = false }
        } catch {
            await MainActor.run { describeError = "\(error)"; isLoadingDescribe = false }
        }
    }
}
