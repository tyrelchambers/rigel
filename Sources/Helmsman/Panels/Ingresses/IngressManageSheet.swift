import SwiftUI

/// Manage sheet for a single Ingress. Structured summary (class, routes, TLS,
/// address) + a control bar (Edit · Delete · View YAML · Ask Claude) + live
/// `kubectl describe`. Callbacks are wired by MainWindow.
struct IngressManageSheet: View {
    let ingress: Ingress
    let context: String?
    let onClose: () -> Void
    let onViewYAML: () -> Void
    let onEdit: (Ingress) -> Void
    let onDelete: (Ingress) -> Void
    let onAskClaude: (Ingress) -> Void

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
                    routesBlock
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
            Image(systemName: "signpost.right.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Accent.primary)
            VStack(alignment: .leading, spacing: 2) {
                Text(ingress.metadata.name)
                    .font(Theme.Font.mono(15, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("Ingress · \(ingress.metadata.namespace ?? "default")")
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
            actionButton(label: "Edit", icon: "pencil", tint: Theme.Accent.primary) { onEdit(ingress) }
            actionButton(label: "Ask Claude", icon: "bubble.left.and.bubble.right", tint: Theme.Accent.primary) { onAskClaude(ingress) }
            Spacer()
            actionButton(label: "Delete", icon: "trash", tint: Theme.Status.failed) { onDelete(ingress) }
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
            kvRow("Class", ingress.className)
            kvRow("TLS", ingress.isTLS ? "enabled" : "none",
                  color: ingress.isTLS ? Theme.Status.running : Theme.Foreground.primary)
            if let address = ingress.address { kvRow("Address", address) }
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

    private var routesBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ROUTES (\(ingress.routes.count))")
                .font(Theme.Font.body(11, weight: .semibold)).tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            if ingress.routes.isEmpty {
                Text("No routing rules")
                    .font(Theme.Font.mono(13)).foregroundStyle(Theme.Foreground.tertiary)
            } else {
                ForEach(Array(ingress.routes.enumerated()), id: \.offset) { _, route in
                    HStack(spacing: 6) {
                        Text(route.host).font(Theme.Font.mono(12, weight: .medium)).foregroundStyle(Theme.Foreground.primary)
                        Text(route.path).font(Theme.Font.mono(11)).foregroundStyle(Theme.Foreground.secondary)
                        Image(systemName: "arrow.right").font(.system(size: 8)).foregroundStyle(Theme.Foreground.tertiary)
                        Text(route.port.isEmpty ? route.service : "\(route.service):\(route.port)")
                            .font(Theme.Font.mono(11)).foregroundStyle(Theme.Accent.primary)
                        Spacer()
                    }
                    .lineLimit(1).truncationMode(.middle)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(Theme.Surface.elevated)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
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
        args.append(contentsOf: ["describe", "ingress", ingress.metadata.name])
        if let ns = ingress.metadata.namespace { args.append(contentsOf: ["-n", ns]) }
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
