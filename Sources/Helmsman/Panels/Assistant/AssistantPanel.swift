import SwiftUI

struct AssistantPanel: View {
    @Bindable var viewModel: AssistantViewModel
    /// Run a queued suggestion through the app's confirm-sheet flow.
    let onRunSuggestion: (SuggestedAction) -> Void
    /// Re-apply a stored backup YAML (revert), via the confirm sheet.
    let onRevert: (_ yaml: String, _ label: String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if let err = viewModel.actionError {
                Text(err)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Status.failed)
                    .padding(.horizontal, 16).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Status.failed.opacity(0.08))
            }
            ScrollView {
                if viewModel.isInstalled {
                    controlPanel
                } else {
                    installer
                }
            }
        }
        .background(Theme.Surface.primary)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "sparkles").foregroundStyle(Theme.Accent.primary)
            Text("Assistant").font(Theme.Font.body(15, weight: .semibold)).foregroundStyle(Theme.Foreground.primary)
            if viewModel.isInstalled {
                statusPill
            }
            Spacer()
            if viewModel.working {
                ProgressView().controlSize(.small).tint(Theme.Accent.primary)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var statusPill: some View {
        let on = viewModel.enabled
        let color = on ? Theme.Status.running : Theme.Status.pending
        return Text(on ? "active" : "paused")
            .font(Theme.Font.mono(10, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(color.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    // MARK: - Control panel (installed)

    private var controlPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            statusCard
            killSwitchCard
            if !viewModel.report.isEmpty { reportCard }
            if !viewModel.queue.isEmpty { queueSection }
            auditSection
            uninstallCard
        }
        .padding(16)
    }

    private var statusCard: some View {
        card {
            HStack(spacing: 16) {
                metric("Status", viewModel.enabled ? "Active" : "Paused", viewModel.enabled ? Theme.Status.running : Theme.Status.pending)
                if let s = viewModel.status {
                    metric("Spend", String(format: "$%.2f / $%.0f", s.spentUsd, s.spendCapUsd), Theme.Foreground.primary)
                    metric("Version", s.version, Theme.Foreground.secondary)
                    metric("Heartbeat", relative(s.heartbeatAt), Theme.Foreground.secondary)
                } else {
                    Text("waiting for first heartbeat…")
                        .font(Theme.Font.mono(11)).foregroundStyle(Theme.Foreground.tertiary)
                }
                if let t = viewModel.tokenExpiry {
                    metric("Token", tokenLabel(t), tokenColor(t.level))
                }
                Spacer()
            }
        }
    }

    private var killSwitchCard: some View {
        card {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Kill switch").font(Theme.Font.body(12, weight: .semibold)).foregroundStyle(Theme.Foreground.primary)
                    Text(viewModel.enabled ? "Agent is acting on incidents." : "Agent is paused — it will not act.")
                        .font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.secondary)
                }
                Spacer()
                Button {
                    let next = !viewModel.enabled
                    Task { await viewModel.setEnabled(next) }
                } label: {
                    Text(viewModel.enabled ? "Pause" : "Resume")
                        .font(Theme.Font.body(12, weight: .semibold))
                        .foregroundStyle(viewModel.enabled ? Theme.Status.failed : Theme.Foreground.inverse)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(viewModel.enabled ? Theme.Status.failed.opacity(0.15) : Theme.Accent.primary)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
                .buttonStyle(.plain)
                .disabled(viewModel.working)
            }
        }
    }

    private var reportCard: some View {
        card {
            VStack(alignment: .leading, spacing: 4) {
                Text("Last report").font(Theme.Font.body(12, weight: .semibold)).foregroundStyle(Theme.Foreground.primary)
                Text(viewModel.report).font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.secondary)
            }
        }
    }

    private var queueSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("Awaiting your approval (\(viewModel.queue.count))")
            ForEach(viewModel.queue) { q in
                card {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(q.incident).font(Theme.Font.mono(11, weight: .medium)).foregroundStyle(Theme.Foreground.primary)
                        Text(q.suggestion).font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.primary)
                        Text(q.reason).font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.tertiary)
                        if let action = q.action {
                            SuggestedActionList(actions: [action], onTap: onRunSuggestion)
                        }
                    }
                }
            }
        }
    }

    private var auditSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("Activity")
            if viewModel.audit.isEmpty {
                Text("No actions yet.").font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.tertiary)
            } else {
                ForEach(viewModel.audit) { entry in
                    auditRow(entry)
                }
            }
        }
    }

    private func auditRow(_ e: AssistantAuditEntry) -> some View {
        card {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(outcomeGlyph(e.outcome)).foregroundStyle(outcomeColor(e.outcome))
                    Text(e.incident).font(Theme.Font.mono(11, weight: .medium)).foregroundStyle(Theme.Foreground.primary).lineLimit(1)
                    Spacer()
                    Text(e.tier.uppercased()).font(Theme.Font.mono(9, weight: .medium)).foregroundStyle(Theme.Foreground.tertiary)
                    Text(relative(e.at)).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary)
                }
                if let p = e.proposal {
                    Text(p).font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.secondary)
                }
                if let c = e.command {
                    Text(c).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary).textSelection(.enabled)
                }
                if !e.detail.isEmpty {
                    Text(e.detail).font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.tertiary).lineLimit(3)
                }
                if let ref = e.backupRef, let yaml = viewModel.backupYAML(ref: ref) {
                    Button {
                        onRevert(yaml, e.proposal ?? e.incident)
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "arrow.uturn.backward").font(.system(size: 9))
                            Text("Revert").font(Theme.Font.body(11, weight: .medium))
                        }
                        .foregroundStyle(Theme.Accent.primary)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Theme.Accent.primaryDim)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var uninstallCard: some View {
        card {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Uninstall").font(Theme.Font.body(12, weight: .semibold)).foregroundStyle(Theme.Foreground.primary)
                    Text("Removes the agent Deployment, RBAC, and token. Keeps the audit history.")
                        .font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.secondary)
                }
                Spacer()
                Button(role: .destructive) {
                    Task { await viewModel.uninstall() }
                } label: {
                    Text("Uninstall").font(Theme.Font.body(12, weight: .semibold))
                        .foregroundStyle(Theme.Status.failed)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Theme.Status.failed.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
                .buttonStyle(.plain)
                .disabled(viewModel.working)
            }
        }
    }

    // MARK: - Installer (not installed)

    private var installer: some View {
        VStack(alignment: .leading, spacing: 14) {
            card {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Install the in-cluster assistant").font(Theme.Font.body(13, weight: .semibold)).foregroundStyle(Theme.Foreground.primary)
                    Text("A pod that watches the cluster and auto-fixes safe issues while you're away. It is caged by RBAC: it can read everything except secrets, and only restart/scale/rollback workloads, delete crashlooping pods, and cordon nodes. It can never delete namespaces, PVCs, secrets, or change RBAC — those only ever appear here as suggestions for you to run.")
                        .font(Theme.Font.body(12)).foregroundStyle(Theme.Foreground.secondary)
                }
            }

            card {
                VStack(alignment: .leading, spacing: 8) {
                    Text("1. Subscription token").font(Theme.Font.body(12, weight: .semibold)).foregroundStyle(Theme.Foreground.primary)
                    Text("On a machine logged into your Claude plan, run:").font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.secondary)
                    Text("claude setup-token").font(Theme.Font.mono(11)).foregroundStyle(Theme.Accent.primary).textSelection(.enabled)
                    Text("Paste the token below — it's stored as a Kubernetes Secret, never shown again.").font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.secondary)
                    SecureField("CLAUDE_CODE_OAUTH_TOKEN", text: $viewModel.token)
                        .textFieldStyle(.plain).font(Theme.Font.mono(11))
                        .padding(.horizontal, 8).padding(.vertical, 6).inputChrome()
                }
            }

            card {
                VStack(alignment: .leading, spacing: 8) {
                    Text("2. Configuration").font(Theme.Font.body(12, weight: .semibold)).foregroundStyle(Theme.Foreground.primary)
                    labeledField("Image", text: $viewModel.config.image)
                    labeledField("Namespaces (blank = all)", text: $viewModel.config.namespaces)
                    HStack(spacing: 8) {
                        Text("Spend cap ($/mo)").font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.secondary).frame(width: 150, alignment: .leading)
                        TextField("", value: $viewModel.config.spendCapUsd, format: .number)
                            .textFieldStyle(.plain).font(Theme.Font.mono(11))
                            .padding(.horizontal, 8).padding(.vertical, 6).inputChrome().frame(width: 100)
                    }
                }
            }

            card {
                VStack(alignment: .leading, spacing: 8) {
                    Text("3. Review manifests").font(Theme.Font.body(12, weight: .semibold)).foregroundStyle(Theme.Foreground.primary)
                    Text("Exactly what will be applied — including the RBAC cage. Nothing is applied until you click Install.")
                        .font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.secondary)
                    ScrollView {
                        Text(viewModel.manifestPreview)
                            .font(Theme.Font.mono(10)).foregroundStyle(Theme.Foreground.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    }
                    .frame(height: 220)
                    .padding(8).background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
            }

            Button {
                Task { await viewModel.install() }
            } label: {
                Text(viewModel.working ? "Installing…" : "Install")
                    .font(Theme.Font.body(13, weight: .semibold)).foregroundStyle(Theme.Foreground.inverse)
                    .frame(maxWidth: .infinity).padding(.vertical, 9)
                    .background(Theme.Accent.primary).clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }
            .buttonStyle(.plain)
            .disabled(viewModel.working || viewModel.token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(16)
    }

    // MARK: - Bits

    private func labeledField(_ label: String, text: Binding<String>) -> some View {
        HStack(spacing: 8) {
            Text(label).font(Theme.Font.body(11)).foregroundStyle(Theme.Foreground.secondary).frame(width: 150, alignment: .leading)
            TextField("", text: text)
                .textFieldStyle(.plain).font(Theme.Font.mono(11))
                .padding(.horizontal, 8).padding(.vertical, 6).inputChrome()
        }
    }

    private func sectionTitle(_ s: String) -> some View {
        Text(s).font(Theme.Font.body(12, weight: .semibold)).foregroundStyle(Theme.Foreground.secondary)
    }

    private func metric(_ label: String, _ value: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(Theme.Font.mono(9, weight: .medium)).foregroundStyle(Theme.Foreground.tertiary)
            Text(value).font(Theme.Font.body(13, weight: .semibold)).foregroundStyle(color)
        }
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Surface.elevated)
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.md).strokeBorder(Theme.Border.subtle, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private func tokenLabel(_ t: TokenExpiry.Status) -> String {
        switch t.level {
        case .expired: return "expired — re-run setup-token"
        case .warning: return "\(t.daysRemaining)d left"
        case .ok: return "\(t.daysRemaining)d left"
        }
    }

    private func tokenColor(_ level: TokenExpiry.Level) -> Color {
        switch level {
        case .ok: return Theme.Foreground.secondary
        case .warning: return Theme.Status.pending
        case .expired: return Theme.Status.failed
        }
    }

    private func outcomeGlyph(_ o: String) -> String {
        switch o {
        case "success": return "✓"
        case "failure": return "✗"
        case "queued": return "▸"
        default: return "•"
        }
    }

    private func outcomeColor(_ o: String) -> Color {
        switch o {
        case "success": return Theme.Status.running
        case "failure": return Theme.Status.failed
        case "queued": return Theme.Status.pending
        default: return Theme.Foreground.tertiary
        }
    }

    /// Compact relative time from an ISO-8601 string.
    private func relative(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        guard let date = f.date(from: iso) else { return "" }
        let dt = Date().timeIntervalSince(date)
        if dt < 60 { return "\(Int(max(0, dt)))s" }
        if dt < 3600 { return "\(Int(dt / 60))m" }
        if dt < 86400 { return "\(Int(dt / 3600))h" }
        return "\(Int(dt / 86400))d"
    }
}
