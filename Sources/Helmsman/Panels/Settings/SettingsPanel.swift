import SwiftUI

/// Settings tab. Structured as stacked sections so it can grow; currently holds
/// the Signal-notifications setup (deploy bridge → link phone → recipients → test).
struct SettingsPanel: View {
    @Bindable var viewModel: SettingsViewModel
    /// Jump to the Assistant tab (notifications are consumed by the agent).
    let onOpenAssistant: () -> Void
    /// Daily app-update-check state + controls (owned by MainWindow).
    var updates: UpdateCheckStore? = nil
    var onToggleDailyUpdates: (Bool) -> Void = { _ in }
    var onCheckUpdatesNow: () -> Void = {}

    @State private var recipientsText = ""

    /// Recipients to show in the field, defaulting to the linked number itself
    /// (send-to-self) when none are configured yet.
    private var defaultedRecipients: String {
        viewModel.signalRecipients.isEmpty ? viewModel.signalNumber : viewModel.signalRecipients
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                PanelTitle(title: PanelKind.settings.title, subtitle: PanelKind.settings.subtitle,
                           titleFont: Theme.Font.mono(20, weight: .semibold))
                signalSection
                selfHostSection
                if let updates { updatesSection(updates) }
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

    private func updatesSection(_ updates: UpdateCheckStore) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(Theme.Accent.primary)
                Text("App updates")
                    .font(Theme.Font.body(15, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
            }
            Text("Check your installed catalog apps against their registries for newer stable versions. When a check can't be made by tag (e.g. an image pinned to :latest), Claude is asked to determine the latest release.")
                .font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.secondary)

            Toggle(isOn: Binding(
                get: { updates.dailyChecksEnabled },
                set: { onToggleDailyUpdates($0) }
            )) {
                Text("Check for updates once a day")
                    .font(Theme.Font.body(12, weight: .medium)).foregroundStyle(Theme.Foreground.primary)
            }
            .toggleStyle(.switch).tint(Theme.Accent.primary)

            HStack(spacing: 10) {
                Button(action: onCheckUpdatesNow) {
                    HStack(spacing: 5) {
                        if updates.isChecking {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .medium))
                        }
                        Text(updates.isChecking ? "Checking…" : "Check for updates")
                            .font(Theme.Font.body(12, weight: .medium))
                    }
                }
                .buttonStyle(.borderedProminent).tint(Theme.Accent.primary)
                .disabled(updates.isChecking)

                if !updates.isChecking, let last = updates.lastChecked {
                    Text("Last checked \(last.formatted(.relative(presentation: .named)))")
                        .font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
                }
                if updates.updateCount > 0 {
                    Text("\(updates.updateCount) update\(updates.updateCount == 1 ? "" : "s") available")
                        .font(Theme.Font.mono(11, weight: .medium))
                        .foregroundStyle(Theme.Status.pending)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }

    // MARK: - Self-hosted defaults

    /// Per-context conventions the catalog install wizard bakes into the prompt
    /// it sends Claude: the cert-manager ClusterIssuer, the ingress base domain,
    /// the image-pull secret, and the public edge IP.
    private var selfHostSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "lock.shield.fill").foregroundStyle(Theme.Accent.primary)
                Text("Self-hosted app defaults")
                    .font(Theme.Font.body(15, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
            }
            Text("Used by the catalog install wizard when it asks Claude to generate manifests for this cluster. The ClusterIssuer issues TLS certificates for app ingresses. Leave a field blank to omit it. These are saved per kubectl context.")
                .font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.secondary)

            selfHostField(label: "Cluster issuer", placeholder: "letsencrypt-prod",
                          text: $viewModel.clusterIssuer,
                          help: "cert-manager ClusterIssuer name for the cert-manager.io/cluster-issuer annotation.")
            selfHostField(label: "Ingress domain", placeholder: "apps.example.com",
                          text: $viewModel.ingressDomain,
                          help: "Base domain hostnames default under (<app>.<domain>).")
            selfHostField(label: "Image pull secret", placeholder: "(none)",
                          text: $viewModel.imagePullSecret,
                          help: "Pull-secret name added to pod specs. Blank = no imagePullSecrets.")
            selfHostField(label: "Redirect middleware", placeholder: "(none)",
                          text: $viewModel.redirectMiddleware,
                          help: "Traefik HTTPS-redirect middleware ref, e.g. default-redirect-https@kubernetescrd. Blank = no router.middlewares annotation.")
            selfHostField(label: "Edge IP", placeholder: "(optional)",
                          text: $viewModel.edgeIP,
                          help: "Public IP your *.domain A-records point at. Informational only.")

            HStack(spacing: 10) {
                Button("Save defaults") { viewModel.saveSelfHostDefaults() }
                    .buttonStyle(.borderedProminent).tint(Theme.Accent.primary)
                if viewModel.selfHostSaved {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.Status.running)
                        Text("Saved").font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }

    private func selfHostField(label: String, placeholder: String,
                               text: Binding<String>, help: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(label).font(Theme.Font.body(11, weight: .medium))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .frame(width: 120, alignment: .leading)
                TextField(placeholder, text: text)
                    .textFieldStyle(.plain).font(Theme.Font.mono(11))
                    .padding(.horizontal, 8).padding(.vertical, 6).inputChrome()
                    .onChange(of: text.wrappedValue) { _, _ in viewModel.selfHostSaved = false }
            }
            Text(help).font(Theme.Font.body(10)).foregroundStyle(Theme.Foreground.tertiary)
                .padding(.leading, 130)
        }
    }

    private var signalSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "bell.badge.fill").foregroundStyle(Theme.Accent.primary)
                Text("Signal notifications")
                    .font(Theme.Font.body(15, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
            }
            Text("Deploy a self-hosted Signal bridge into the cluster and link your phone so the assistant can message you — and, with two-way enabled, so you can text it back to diagnose issues and approve fixes.")
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
            inboundControls
        }
    }

    /// Two-way Signal opt-in. Only the linked/recipient number can drive the
    /// assistant; texted commands diagnose read-only or approve queued fixes.
    private var inboundControls: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider().overlay(Theme.Border.subtle)
            Toggle(isOn: Binding(
                get: { viewModel.signalInbound },
                set: { on in Task { await viewModel.setInbound(on) } }
            )) {
                Text("Let me text the assistant back (two-way)")
                    .font(Theme.Font.body(12, weight: .medium)).foregroundStyle(Theme.Foreground.primary)
            }
            .toggleStyle(.switch).tint(Theme.Accent.primary).disabled(viewModel.working)
            Text("The agent polls the bridge for messages from your recipients. Ask anything to diagnose read-only; reply \"queue\" to list pending fixes and \"approve N\" to run one. Other senders are ignored.")
                .font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
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
