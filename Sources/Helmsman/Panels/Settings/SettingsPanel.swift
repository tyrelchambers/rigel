import SwiftUI

/// Settings tab. Structured as stacked sections so it can grow; currently holds
/// the Signal-notifications setup (deploy bridge → link phone → recipients → test).
struct SettingsPanel: View {
    @Bindable var viewModel: SettingsViewModel
    /// Jump to the Assistant tab (notifications are consumed by the agent).
    let onOpenAssistant: () -> Void

    @State private var recipientsText = ""

    /// Recipients to show in the field, defaulting to the linked number itself
    /// (send-to-self) when none are configured yet.
    private var defaultedRecipients: String {
        viewModel.signalRecipients.isEmpty ? viewModel.signalNumber : viewModel.signalRecipients
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Settings")
                    .font(Theme.Font.mono(20, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                signalSection
            }
            .padding(20)
            .frame(maxWidth: 720, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.Surface.primary)
        .onAppear { recipientsText = defaultedRecipients }
        .onChange(of: viewModel.signalRecipients) { _, _ in recipientsText = defaultedRecipients }
        .onDisappear { viewModel.stopLinking() }
    }

    private var signalSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "bell.badge.fill").foregroundStyle(Theme.Accent.primary)
                Text("Signal notifications")
                    .font(Theme.Font.body(15, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
            }
            Text("Deploy a self-hosted Signal bridge into the cluster and link your phone so the assistant can message you.")
                .font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.secondary)

            statusRow
            if let err = viewModel.actionError { errorBox(err) }

            switch viewModel.status {
            case .notDeployed: deployControls
            case .deploying:   busy("Deploying bridge…")
            case .starting:    busy("Bridge starting…")
            case .ready:       linkControls
            case .linked:      linkedControls
            }
        }
        .padding(16)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg).strokeBorder(Theme.Border.subtle, lineWidth: 1))
    }

    private var statusRow: some View {
        HStack(spacing: 8) {
            Circle().fill(statusColor).frame(width: 8, height: 8)
            Text(statusLabel).font(Theme.Font.mono(11)).foregroundStyle(Theme.Foreground.secondary)
            Spacer()
            Text("ns: \(viewModel.targetNamespace)").font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
        }
    }

    private var deployControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { Task { await viewModel.deploy() } } label: {
                Label("Deploy Signal bridge", systemImage: "arrow.down.circle.fill")
                    .font(Theme.Font.body(13, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.inverse)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Theme.Accent.primary)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain).disabled(viewModel.working)

            DisclosureGroup("Show manifest") {
                ScrollView {
                    Text(SignalBridgeManifests.manifest(namespace: viewModel.targetNamespace))
                        .font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.secondary)
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(10)
                }
                .frame(height: 200).background(Theme.Surface.field)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
        }
    }

    private var linkControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            if viewModel.linking {
                if let png = viewModel.qrPNG, let img = NSImage(data: png) {
                    Text("Scan in Signal → Settings → Linked devices → Link new device")
                        .font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.secondary)
                    Image(nsImage: img).resizable().interpolation(.none)
                        .frame(width: 220, height: 220)
                        .background(Color.white).clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                } else {
                    busy("Opening link channel…")
                }
                Button("Cancel") { viewModel.stopLinking() }
                    .buttonStyle(.plain).font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.secondary)
            } else {
                Button { viewModel.startLinking() } label: {
                    Label("Link phone", systemImage: "qrcode")
                        .font(Theme.Font.body(13, weight: .semibold))
                        .foregroundStyle(Theme.Foreground.inverse)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Theme.Accent.primary).clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var linkedControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.seal.fill").foregroundStyle(Theme.Status.running)
                Text("Linked as \(viewModel.signalNumber)").font(Theme.Font.mono(12)).foregroundStyle(Theme.Foreground.primary)
                Spacer()
                Button("Re-link") { viewModel.startLinking() }
                    .buttonStyle(.plain).font(Theme.Font.body(11, weight: .medium)).foregroundStyle(Theme.Accent.primary)
            }
            if viewModel.linking { linkControls }
            HStack(spacing: 8) {
                Text("Recipients").font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.secondary).frame(width: 90, alignment: .leading)
                TextField("+15551234567 (comma-sep)", text: $recipientsText)
                    .textFieldStyle(.plain).font(Theme.Font.mono(11)).padding(.horizontal, 8).padding(.vertical, 6).inputChrome()
                Button("Save") { Task { await viewModel.saveRecipients(recipientsText) } }
                    .buttonStyle(.plain).font(Theme.Font.body(11, weight: .medium)).foregroundStyle(Theme.Accent.primary)
            }
            HStack(spacing: 10) {
                Button { Task { await viewModel.sendTest() } } label: {
                    Label("Send test notification", systemImage: "paperplane.fill")
                        .font(Theme.Font.body(12, weight: .medium)).foregroundStyle(Theme.Accent.primary)
                }
                .buttonStyle(.plain).disabled(viewModel.working)
                Button("Open Assistant") { onOpenAssistant() }
                    .buttonStyle(.plain).font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.tertiary)
            }
        }
    }

    private func busy(_ label: String) -> some View {
        HStack(spacing: 8) { ProgressView().controlSize(.small)
            Text(label).font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.secondary) }
    }

    private func errorBox(_ msg: String) -> some View {
        Text(msg).font(Theme.Font.mono(11)).foregroundStyle(Theme.Status.failed)
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Status.failed.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var statusColor: Color {
        switch viewModel.status {
        case .linked: return Theme.Status.running
        case .ready: return Theme.Accent.primary
        case .notDeployed: return Theme.Foreground.tertiary
        default: return Theme.Status.pending
        }
    }
    private var statusLabel: String {
        switch viewModel.status {
        case .notDeployed: return "Bridge not deployed"
        case .deploying: return "Deploying…"
        case .starting: return "Bridge starting…"
        case .ready: return "Bridge ready — link a phone"
        case .linked: return "Linked"
        }
    }
}
