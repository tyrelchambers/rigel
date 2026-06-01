import SwiftUI
import Observation

/// Multi-step modal that drives a Claude-generated install of one `CatalogApp`
/// onto the cluster. State is owned by `CatalogInstallWizardModel`; the views
/// below are dumb renderers. See plan/streamed-soaring-dahl.md for the full
/// step-by-step contract.
struct CatalogInstallWizard: View {
    @Bindable var model: CatalogInstallWizardModel
    let onClose: () -> Void
    /// Push the wizard's transcript over to the main chat ViewModel when the
    /// user hits "Hand off to main chat" on the Failed step.
    var onHandoffToChat: (String) -> Void = { _ in }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            stepView
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider().background(Theme.Border.subtle)
            footer
        }
        .frame(width: 960, height: 680)
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: model.app.iconSystemName)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Theme.Accent.primary)
                .frame(width: 36, height: 36)
                .background(Theme.Accent.primaryDim)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            VStack(alignment: .leading, spacing: 2) {
                Text("Install \(model.app.name)")
                    .font(Theme.Font.body(15, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                StepIndicator(step: model.step)
            }
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(width: 28, height: 28)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.escape, modifiers: [])
            .help("Close wizard")
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
        .background(Theme.Surface.elevated)
    }

    @ViewBuilder private var stepView: some View {
        switch model.step {
        case .configure:
            ConfigureStep(model: model)
        case .generating:
            GeneratingStep(model: model)
        case .review:
            ReviewStep(model: model)
        case .applying:
            ApplyingStep(model: model)
        case .verifying:
            VerifyingStep(model: model)
        case .done:
            DoneStep(model: model, onClose: onClose)
        case .failed(let reason):
            FailedStep(model: model, reason: reason, onClose: onClose, onHandoff: { prompt in
                onHandoffToChat(prompt)
                onClose()
            })
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Spacer()
            switch model.step {
            case .configure:
                TertiaryButton(label: "Cancel", action: onClose)
                PrimaryButton(label: "Generate manifest", systemImage: "wand.and.stars", action: model.advanceFromConfigure)
                    .disabled(!model.canAdvanceFromConfigure)
            case .generating:
                // Footer controls live inside the step (chat strip + use-this-manifest).
                EmptyView()
            case .review:
                TertiaryButton(label: "Back to Claude", action: { model.step = .generating })
                PrimaryButton(label: "Apply to cluster", systemImage: "arrow.down.app.fill", action: model.advanceFromReview)
                    .disabled(model.manifestYAML.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            case .applying, .verifying:
                EmptyView()
            case .done, .failed:
                // Per-step footers — handled inside the step view.
                EmptyView()
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
    }
}

// MARK: - Step indicator

private struct StepIndicator: View {
    let step: WizardStep
    private let order: [WizardStep] = [.configure, .generating, .review, .applying, .verifying, .done]

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(order.enumerated()), id: \.offset) { _, s in
                Text(label(for: s))
                    .font(Theme.Font.mono(9, weight: state(of: s) == .current ? .semibold : .regular))
                    .foregroundStyle(color(for: state(of: s)))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(state(of: s) == .current ? Theme.Accent.primaryDim : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                if s != .done {
                    Text("›")
                        .font(Theme.Font.mono(9))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
            }
        }
    }

    private enum State { case past, current, future }

    private func state(of s: WizardStep) -> State {
        guard let currentIdx = order.firstIndex(of: stepFamily(step)),
              let thisIdx = order.firstIndex(of: s) else { return .future }
        if thisIdx < currentIdx { return .past }
        if thisIdx == currentIdx { return .current }
        return .future
    }

    /// Collapse `.failed(_)` onto its sibling state (after applying) for the
    /// indicator's purposes.
    private func stepFamily(_ s: WizardStep) -> WizardStep {
        if case .failed = s { return .applying }
        return s
    }

    private func label(for s: WizardStep) -> String {
        switch s {
        case .configure:  return "configure"
        case .generating: return "generate"
        case .review:     return "review"
        case .applying:   return "apply"
        case .verifying:  return "verify"
        case .done:       return "done"
        case .failed:     return "failed"
        }
    }

    private func color(for state: State) -> Color {
        switch state {
        case .past:    return Theme.Foreground.secondary
        case .current: return Theme.Accent.primary
        case .future:  return Theme.Foreground.tertiary
        }
    }
}

// MARK: - Configure step

private struct ConfigureStep: View {
    @Bindable var model: CatalogInstallWizardModel
    @FocusState private var focus: Field?

    private enum Field { case instance, namespace, hostname, storage, notes }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Pick the basics. Claude will use these values to generate a manifest tailored to your cluster.")
                    .font(Theme.Font.body(12))
                    .foregroundStyle(Theme.Foreground.secondary)
                Group {
                    FieldRow(label: "Instance name") {
                        TextField("", text: $model.instance)
                            .textFieldStyle(.plain)
                            .font(Theme.Font.mono(12))
                            .focused($focus, equals: .instance)
                            .padding(.horizontal, 10).padding(.vertical, 8)
                            .inputChrome(focused: focus == .instance)
                    }
                    FieldRow(label: "Namespace") {
                        TextField("default", text: $model.namespace)
                            .textFieldStyle(.plain)
                            .font(Theme.Font.mono(12))
                            .focused($focus, equals: .namespace)
                            .padding(.horizontal, 10).padding(.vertical, 8)
                            .inputChrome(focused: focus == .namespace)
                    }
                    if model.app.exposesIngress {
                        FieldRow(label: "Ingress hostname") {
                            TextField(model.hostnamePlaceholder, text: $model.hostname)
                                .textFieldStyle(.plain)
                                .font(Theme.Font.mono(12))
                                .focused($focus, equals: .hostname)
                                .padding(.horizontal, 10).padding(.vertical, 8)
                                .inputChrome(focused: focus == .hostname)
                        }
                    }
                    FieldRow(label: "Node pin") {
                        Picker("", selection: $model.nodePin) {
                            Text("Any (recommended: \(model.recommendedNodeName ?? "—"))").tag(String?.none)
                            ForEach(model.fittingNodeNames, id: \.self) { n in
                                Text(n).tag(String?.some(n))
                            }
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)
                        .font(Theme.Font.mono(12))
                        .tint(Theme.Foreground.primary)
                    }
                    if model.app.persistence {
                        FieldRow(label: "Storage (GiB)") {
                            TextField("", value: $model.storageGiB, format: .number)
                                .textFieldStyle(.plain)
                                .font(Theme.Font.mono(12))
                                .focused($focus, equals: .storage)
                                .padding(.horizontal, 10).padding(.vertical, 8)
                                .inputChrome(focused: focus == .storage)
                                .frame(width: 120)
                        }
                    }
                    FieldRow(label: "Notes for Claude") {
                        TextEditor(text: $model.notes)
                            .font(Theme.Font.body(12))
                            .scrollContentBackground(.hidden)
                            .focused($focus, equals: .notes)
                            .padding(8)
                            .frame(height: 80)
                            .inputChrome(focused: focus == .notes)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(20)
        }
    }
}

private struct FieldRow<Content: View>: View {
    let label: String
    @ViewBuilder let content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(Theme.Font.mono(9, weight: .semibold))
                .foregroundStyle(Theme.Foreground.tertiary)
                .tracking(0.5)
            content()
                .foregroundStyle(Theme.Foreground.primary)
        }
    }
}

// MARK: - Generating step

private struct GeneratingStep: View {
    @Bindable var model: CatalogInstallWizardModel
    @State private var showRawYAML = false

    private var summary: ManifestSummary? {
        model.currentManifestYAML.flatMap { ManifestSummary.parse($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(summary == nil ? "Working with Claude" : "What will be deployed")
                    .font(Theme.Font.body(14, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                if model.isStreaming {
                    ProgressView().controlSize(.small).tint(Theme.Accent.primary)
                }
                Spacer()
                if let err = model.generateError {
                    Text(err)
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Status.failed)
                }
                if summary != nil {
                    ViewModeToggle(showRawYAML: $showRawYAML)
                }
            }

            if let summary {
                manifestPane(summary: summary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                Divider().background(Theme.Border.subtle)
                WizardChatStrip(model: model, useThisManifestEnabled: model.hasManifestReady, collapseManifest: true)
                    .frame(height: 200)
            } else {
                WizardChatStrip(model: model, useThisManifestEnabled: model.hasManifestReady, collapseManifest: true)
            }
        }
        .padding(20)
    }

    @ViewBuilder private func manifestPane(summary: ManifestSummary) -> some View {
        if showRawYAML {
            YAMLDisplay(yaml: .constant(model.currentManifestYAML ?? ""), editable: false)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        } else {
            ScrollView {
                ManifestSummaryView(summary: summary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 2)
            }
        }
    }
}

/// Small segmented switch between the visual summary and the raw manifest.
private struct ViewModeToggle: View {
    @Binding var showRawYAML: Bool

    var body: some View {
        HStack(spacing: 2) {
            segment(title: "Visual", active: !showRawYAML) { showRawYAML = false }
            segment(title: "YAML", active: showRawYAML) { showRawYAML = true }
        }
        .padding(2)
        .background(Theme.Surface.sunken)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private func segment(title: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(Theme.Font.mono(9, weight: .semibold))
                .foregroundStyle(active ? Theme.Foreground.primary : Theme.Foreground.tertiary)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(active ? Theme.Surface.field : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Review step

private struct ReviewStep: View {
    @Bindable var model: CatalogInstallWizardModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Review")
                    .font(Theme.Font.body(14, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("\(model.manifestYAML.split(separator: "\n").count) lines")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
                Spacer()
                Text("Edit freely — what you see is what we apply.")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            YAMLDisplay(yaml: $model.manifestYAML, editable: true)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .padding(20)
    }
}

// MARK: - Applying step

private struct ApplyingStep: View {
    @Bindable var model: CatalogInstallWizardModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small).tint(Theme.Accent.primary)
                Text("Applying manifest to the cluster…")
                    .font(Theme.Font.body(13, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary)
            }
            ScrollView {
                Text(model.applyLog.isEmpty ? "kubectl apply -f - (no output yet)" : model.applyLog)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
            }
            .background(Theme.Surface.sunken)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .padding(20)
    }
}

// MARK: - Verifying step

private struct VerifyingStep: View {
    @Bindable var model: CatalogInstallWizardModel
    @State private var chatExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            statusHeader
            HStack(alignment: .top, spacing: 12) {
                resourcesColumn
                    .frame(width: 360, alignment: .topLeading)
                activityColumn
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            askClaude
        }
        .padding(20)
    }

    private var statusHeader: some View {
        HStack(spacing: 8) {
            if model.verifyTimedOut {
                Image(systemName: "clock.badge.exclamationmark.fill")
                    .foregroundStyle(Theme.Status.pending)
            } else if model.step == .done {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Theme.Status.running)
            } else {
                ProgressView().controlSize(.small).tint(Theme.Accent.primary)
            }
            Text(statusMessage)
                .font(Theme.Font.body(13, weight: .medium))
                .foregroundStyle(Theme.Foreground.primary)
            Spacer()
            Text("ns=\(model.namespace)  ·  instance=\(model.instance)")
                .font(Theme.Font.mono(9))
                .foregroundStyle(Theme.Foreground.tertiary)
        }
    }

    private var statusMessage: String {
        if model.verifyTimedOut {
            return "Pods didn't reach Ready within 90s — investigate with Claude or close."
        }
        return "Rolling out — watching resources come up…"
    }

    private var resourcesColumn: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(title: "RESOURCES", systemImage: "shippingbox.fill")
            if model.verifyResources.isEmpty {
                Text("Parsing the applied manifest…")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(model.verifyResources) { res in
                            VerifyResourceRow(
                                resource: res,
                                pods: res.isWorkload ? model.pods(forWorkload: res.name) : []
                            )
                        }
                    }
                }
            }
        }
    }

    private var activityColumn: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(title: "ACTIVITY", systemImage: "dot.radiowaves.left.and.right")
            ActivityFeed(events: model.installEvents)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var askClaude: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                chatExpanded.toggle()
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: chatExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                    Text(chatExpanded ? "Hide Claude" : "Ask Claude")
                        .font(Theme.Font.body(11, weight: .medium))
                }
                .foregroundStyle(Theme.Foreground.secondary)
            }
            .buttonStyle(.plain)
            if chatExpanded {
                WizardChatStrip(model: model, useThisManifestEnabled: false)
                    .frame(maxHeight: 240)
            }
        }
    }
}

private struct SectionLabel: View {
    let title: String
    let systemImage: String
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage)
                .font(.system(size: 9))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text(title)
                .font(Theme.Font.mono(9, weight: .semibold))
                .foregroundStyle(Theme.Foreground.tertiary)
                .tracking(0.5)
        }
    }
}

private struct VerifyResourceRow: View {
    let resource: VerifyResource
    let pods: [Pod]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 11))
                    .foregroundStyle(tint)
                Text(resource.kind)
                    .font(Theme.Font.mono(9, weight: .semibold))
                    .foregroundStyle(Theme.Accent.primary)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Theme.Accent.primaryDim)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                Text(resource.name)
                    .font(Theme.Font.mono(11, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary)
                    .lineLimit(1).truncationMode(.middle)
                Spacer()
                Text(statusLabel)
                    .font(Theme.Font.mono(9, weight: .medium))
                    .foregroundStyle(tint)
            }
            ForEach(pods, id: \.metadata.uid) { pod in
                PodVerifyRow(pod: pod)
                    .padding(.leading, 19)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var icon: String {
        switch resource.state {
        case .applied:  return "checkmark.circle.fill"
        case .creating: return "hourglass"
        case .starting: return "arrow.triangle.2.circlepath"
        case .ready:    return "checkmark.circle.fill"
        case .failed:   return "exclamationmark.triangle.fill"
        }
    }

    private var statusLabel: String {
        switch resource.state {
        case .applied:                       return "applied"
        case .creating:                      return "creating…"
        case let .starting(ready, total):    return "starting \(ready)/\(total)"
        case .ready:                         return "ready"
        case let .failed(reason):            return reason
        }
    }

    private var tint: Color {
        switch resource.state {
        case .ready:    return Theme.Status.running
        case .applied:  return Theme.Status.running
        case .creating, .starting: return Theme.Status.pending
        case .failed:   return Theme.Status.failed
        }
    }
}

/// Live, chronological feed of cluster events for the install. Auto-scrolls to
/// the newest entry so the latest activity is always in view.
private struct ActivityFeed: View {
    let events: [K8sEvent]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if events.isEmpty {
                    Text("No events yet — kubectl just applied; give it a few seconds.")
                        .font(Theme.Font.body(11))
                        .foregroundStyle(Theme.Foreground.tertiary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                } else {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(events) { ActivityRow(event: $0).id($0.id) }
                        Color.clear.frame(height: 1).id("__activity_bottom__")
                    }
                    .padding(8)
                }
            }
            .background(Theme.Surface.sunken)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(Theme.Border.subtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            .onChange(of: events.count) { _, _ in
                proxy.scrollTo("__activity_bottom__", anchor: .bottom)
            }
        }
    }
}

private struct ActivityRow: View {
    let event: K8sEvent

    private var tint: Color { event.isWarning ? Theme.Status.failed : Theme.Status.running }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle().fill(tint).frame(width: 5, height: 5).padding(.top, 4)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(event.reason ?? "—")
                        .font(Theme.Font.mono(10, weight: .semibold))
                        .foregroundStyle(tint)
                    Text(event.involvedObject?.name ?? "")
                        .font(Theme.Font.mono(9))
                        .foregroundStyle(Theme.Foreground.tertiary)
                        .lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    if let count = event.count, count > 1 {
                        Text("×\(count)")
                            .font(Theme.Font.mono(9, weight: .semibold))
                            .foregroundStyle(Theme.Status.pending)
                    }
                }
                Text(event.message ?? "")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 6).padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct PodVerifyRow: View {
    let pod: Pod
    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(pod.metadata.name)
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.primary)
            Spacer()
            Text(label)
                .font(Theme.Font.mono(10))
                .foregroundStyle(color)
            Text(readyString)
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.tertiary)
        }
    }

    private var readyString: String {
        let statuses = pod.status?.containerStatuses ?? []
        let ready = statuses.filter { $0.ready }.count
        let total = statuses.count
        return total == 0 ? "—" : "\(ready)/\(total)"
    }

    private var label: String {
        if let err = pod.errorReason { return err }
        return pod.status?.phase ?? "—"
    }

    private var color: Color {
        if pod.errorReason != nil { return Theme.Status.failed }
        switch pod.status?.phase {
        case "Running":
            let allReady = (pod.status?.containerStatuses ?? []).allSatisfy { $0.ready }
            return allReady ? Theme.Status.running : Theme.Status.pending
        case "Pending": return Theme.Status.pending
        case "Failed":  return Theme.Status.failed
        default:        return Theme.Foreground.tertiary
        }
    }
}

// MARK: - Done step

private struct DoneStep: View {
    @Bindable var model: CatalogInstallWizardModel
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.Status.running)
                Text("Installed")
                    .font(Theme.Font.body(14, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
            }
            if !model.hostname.isEmpty {
                Text("Open: https://\(model.hostname)")
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(Theme.Accent.primary)
                    .textSelection(.enabled)
            }
            HStack {
                Spacer()
                PrimaryButton(label: "Close", systemImage: "checkmark", action: onClose)
            }
        }
        .padding(20)
    }
}

// MARK: - Failed step

private struct FailedStep: View {
    @Bindable var model: CatalogInstallWizardModel
    let reason: String
    let onClose: () -> Void
    let onHandoff: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.Status.failed)
                Text("Install failed")
                    .font(Theme.Font.body(14, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
            }
            ScrollView {
                Text(reason)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Status.failed)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .frame(maxHeight: 140)
            .background(Theme.Status.failed.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Text("Iterate with Claude below — it still has the full transcript and your latest manifest.")
                .font(Theme.Font.body(11))
                .foregroundStyle(Theme.Foreground.secondary)
            WizardChatStrip(model: model, useThisManifestEnabled: model.hasManifestReady)
                .frame(maxHeight: .infinity)
            HStack {
                Spacer()
                TertiaryButton(label: "Close", action: onClose)
                TertiaryButton(label: "Hand off to main chat", action: { onHandoff(model.handoffPromptForMainChat(reason: reason)) })
                PrimaryButton(label: "Retry generate", systemImage: "arrow.clockwise", action: {
                    model.retryGenerate(withError: reason)
                })
            }
        }
        .padding(20)
    }
}

// MARK: - Footer buttons

private struct PrimaryButton: View {
    let label: String
    var systemImage: String? = nil
    let action: () -> Void

    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let systemImage {
                    Image(systemName: systemImage).font(.system(size: 11, weight: .semibold))
                }
                Text(label).font(Theme.Font.body(12, weight: .semibold))
            }
            .foregroundStyle(isEnabled ? Theme.Foreground.inverse : Theme.Foreground.tertiary)
            .padding(.horizontal, 14).padding(.vertical, 6)
            .background(isEnabled ? Theme.Accent.primary : Theme.Surface.sunken)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }
}

private struct TertiaryButton: View {
    let label: String
    let action: () -> Void
    var body: some View {
        Button(label, action: action)
            .buttonStyle(.plain)
            .font(Theme.Font.body(12, weight: .medium))
            .foregroundStyle(Theme.Foreground.secondary)
            .padding(.horizontal, 14).padding(.vertical, 6)
            .background(Theme.Surface.sunken)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(Theme.Border.subtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}
