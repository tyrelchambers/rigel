import SwiftUI
import AppKit

struct ServicesPanel: View {
    @Bindable var viewModel: ServicesViewModel
    let onViewYAML: (_ kind: String, _ name: String, _ namespace: String?) -> Void
    let onAskClaude: (Service) -> Void
    let onManage: (Service) -> Void
    let onCreate: () -> Void
    let onEdit: (Service) -> Void
    let onDelete: (Service) -> Void
    /// Ask the host to open the local-port prompt for this service+port. The
    /// start sheet lives in MainWindow so the manage sheet can trigger it too.
    let onForward: (Service, Service.Port) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            filterBar

            if let err = viewModel.error {
                Text(err)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Status.failed)
                    .padding(.horizontal, 16).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Status.failed.opacity(0.08))
            }

            if !viewModel.portForwards.forwards.isEmpty {
                activeForwards
            }

            if viewModel.filteredServices.isEmpty {
                empty
            } else {
                list
            }
        }
        .background(Theme.Surface.primary)
        .background {
            Button("New service", action: onCreate)
                .keyboardShortcut("n", modifiers: .command)
                .hidden()
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text("Services")
                .font(Theme.Font.body(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Text("\(viewModel.filteredServices.count)")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.Border.subtle)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Spacer()
            if viewModel.isLoading {
                ProgressView().controlSize(.small).tint(Theme.Accent.primary)
            }
            Button(action: onCreate) {
                HStack(spacing: 5) {
                    Image(systemName: "plus").font(.system(size: 10, weight: .semibold))
                    Text("New service").font(Theme.Font.body(12, weight: .medium))
                }
                .foregroundStyle(Theme.Foreground.inverse)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Theme.Accent.primary)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .help("Create a new service (⌘N)")
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var filterBar: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    FilterPill(label: "all ns", isActive: viewModel.namespaceFilter == nil) {
                        viewModel.namespaceFilter = nil
                    }
                    ForEach(viewModel.availableNamespaces, id: \.self) { ns in
                        FilterPill(label: ns, isActive: viewModel.namespaceFilter == ns) {
                            viewModel.namespaceFilter = ns
                        }
                    }
                }
            }
            Spacer(minLength: 4)
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.Foreground.tertiary)
                TextField("search", text: $viewModel.search)
                    .textFieldStyle(.plain)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.primary)
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Theme.Surface.sunken)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(Theme.Border.subtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            .frame(maxWidth: 200)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var activeForwards: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("ACTIVE FORWARDS (\(viewModel.portForwards.forwards.count))")
                .font(Theme.Font.body(9, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            ForEach(viewModel.portForwards.forwards) { fwd in
                ForwardRow(forward: fwd) { viewModel.portForwards.stop(fwd.id) }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Image(systemName: "network")
                .font(.system(size: 28))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text(viewModel.isLoading ? "Loading services…" : "No services found")
                .font(Theme.Font.mono(12))
                .foregroundStyle(Theme.Foreground.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                ForEach(viewModel.filteredServices) { service in
                    Button { onManage(service) } label: {
                        ServiceRow(
                            service: service,
                            endpointCount: viewModel.endpointCount(for: service),
                            isForwarding: isForwarding(service)
                        )
                    }
                    .buttonStyle(.plain)
                    .contextMenu { contextMenu(for: service) }
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
        }
    }

    @ViewBuilder
    private func contextMenu(for service: Service) -> some View {
        let ports = service.forwardablePorts
        if ports.isEmpty {
            Button("Forward port…") {}.disabled(true)
        } else if ports.count == 1 {
            Button("Forward port \(ports[0].port)…") { beginForward(service, port: ports[0]) }
        } else {
            Menu("Forward port…") {
                ForEach(ports, id: \.self) { p in
                    Button(portMenuLabel(p)) { beginForward(service, port: p) }
                }
            }
        }
        Button("Edit service") { onEdit(service) }
        Button("Ask Claude about this service") { onAskClaude(service) }
        Button("View YAML") {
            onViewYAML("service", service.metadata.name, service.metadata.namespace)
        }
        Divider()
        Button("Delete service", role: .destructive) { onDelete(service) }
    }

    private func portMenuLabel(_ p: Service.Port) -> String {
        if let name = p.name, !name.isEmpty { return "\(name) (\(p.port))" }
        return "\(p.port)"
    }

    private func beginForward(_ service: Service, port: Service.Port) {
        onForward(service, port)
    }

    private func isForwarding(_ service: Service) -> Bool {
        let ns = service.metadata.namespace ?? "default"
        return viewModel.portForwards.forwards.contains {
            $0.targetKind == "svc" && $0.targetName == service.metadata.name && $0.namespace == ns
        }
    }
}

/// Identifies a target (service or pod) + port the user chose to forward; drives
/// the start sheet.
struct PortForwardTarget: Identifiable {
    var id: String { "\(targetKind)/\(namespace)/\(targetName):\(remotePort)" }
    let targetKind: String   // "svc" | "pod"
    let targetName: String
    let namespace: String
    let remotePort: Int
}

private struct ForwardRow: View {
    let forward: PortForwardManager.ActiveForward
    let onStop: () -> Void

    private var statusColor: Color {
        switch forward.status {
        case .starting: return Theme.Status.pending
        case .running:  return Theme.Status.running
        case .failed:   return Theme.Status.failed
        }
    }

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(statusColor).frame(width: 6, height: 6)
            Text("\(forward.targetKind)/\(forward.targetName):\(forward.remotePort)")
                .font(Theme.Font.mono(11, weight: .medium))
                .foregroundStyle(Theme.Foreground.primary)
            Text(forward.namespace)
                .font(Theme.Font.mono(9))
                .foregroundStyle(Theme.Foreground.tertiary)

            if case .running = forward.status {
                Button {
                    if let url = URL(string: "http://localhost:\(forward.localPort)") {
                        NSWorkspace.shared.open(url)
                    }
                } label: {
                    Text("localhost:\(forward.localPort)")
                        .font(Theme.Font.mono(11))
                        .foregroundStyle(Theme.Accent.primary)
                        .underline()
                }
                .buttonStyle(.plain)
                .help("Open in browser")
                Button {
                    let pb = NSPasteboard.general
                    pb.clearContents()
                    pb.setString("localhost:\(forward.localPort)", forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc").font(.system(size: 9))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
                .buttonStyle(.plain)
                .help("Copy localhost:\(forward.localPort)")
            } else if case .failed(let msg) = forward.status {
                Text(msg)
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Status.failed)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } else {
                Text("starting…")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }

            Spacer(minLength: 8)
            Button(action: onStop) {
                Text("Stop")
                    .font(Theme.Font.body(11, weight: .medium))
                    .foregroundStyle(Theme.Status.failed)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Theme.Status.failed.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(Theme.Surface.sunken)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

private struct FilterPill: View {
    let label: String
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(isActive ? Theme.Foreground.inverse : Theme.Foreground.secondary)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(isActive ? Theme.Accent.primary : Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(isActive ? Color.clear : Theme.Border.strong, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }
}

private struct ServiceRow: View {
    let service: Service
    let endpointCount: Int?
    let isForwarding: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Rectangle().fill(Theme.Accent.primary).frame(width: 2).frame(maxHeight: .infinity)

            VStack(alignment: .leading, spacing: 6) {
                titleLine
                if service.portSummaries.isEmpty {
                    Text("no ports")
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Foreground.tertiary)
                } else {
                    HStack(spacing: 6) {
                        ForEach(service.portSummaries, id: \.self) { summary in
                            Text(summary)
                                .font(Theme.Font.mono(10))
                                .foregroundStyle(Theme.Accent.primary)
                        }
                    }
                    .lineLimit(1)
                    .truncationMode(.middle)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .trailing, spacing: 2) {
                if let count = endpointCount {
                    Text("\(count) endpoint\(count == 1 ? "" : "s")")
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(count == 0 ? Theme.Status.failed : Theme.Foreground.secondary)
                }
                if let addr = service.externalAddress {
                    Text(addr)
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Foreground.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            .frame(maxWidth: 150, alignment: .trailing)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var titleLine: some View {
        HStack(spacing: 8) {
            Text(service.metadata.name)
                .font(Theme.Font.mono(12, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            if let ns = service.metadata.namespace {
                Text(ns)
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            Badge(text: service.typeLabel, color: Theme.Accent.primary)
            if let ip = service.spec?.clusterIP, !ip.isEmpty, ip != "None" {
                Text(ip)
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            if isForwarding {
                HStack(spacing: 2) {
                    Image(systemName: "arrow.left.arrow.right").font(.system(size: 8))
                    Text("forwarding")
                }
                .font(Theme.Font.mono(9, weight: .semibold))
                .foregroundStyle(Theme.Status.running)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Theme.Status.running.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
        }
    }
}

private struct Badge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(Theme.Font.mono(9, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}
