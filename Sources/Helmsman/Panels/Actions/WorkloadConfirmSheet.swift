import SwiftUI

/// Confirm modal for `WorkloadAction`s triggered from the UI. Mirrors the
/// visual language of `PermissionSheet` (which gates Claude tool requests) so
/// users get one consistent destructive-confirm flow.
struct WorkloadConfirmSheet: View {
    let action: WorkloadAction
    let contextName: String?
    /// Scale uses a stepper. For other actions this is ignored.
    @State var replicas: Int
    @State var drainOpts: DrainOptions

    let onApprove: (WorkloadAction) -> Void
    let onCancel: () -> Void

    @State private var acknowledged = false

    init(action: WorkloadAction, contextName: String?, onApprove: @escaping (WorkloadAction) -> Void, onCancel: @escaping () -> Void) {
        self.action = action
        self.contextName = contextName
        self.onApprove = onApprove
        self.onCancel = onCancel
        if case .scaleDeployment(let d, let to) = action {
            _replicas = State(initialValue: to == 0 ? (d.spec?.replicas ?? d.status?.replicas ?? 1) : to)
        } else {
            _replicas = State(initialValue: 0)
        }
        if case .drainNode(_, let opts) = action {
            _drainOpts = State(initialValue: opts)
        } else {
            _drainOpts = State(initialValue: DrainOptions())
        }
    }

    private var accent: Color {
        action.isHighRisk ? Theme.Status.failed : Theme.Accent.primary
    }

    private var effectiveAction: WorkloadAction {
        switch action {
        case .scaleDeployment(let d, _):
            return .scaleDeployment(d, to: replicas)
        case .drainNode(let n, _):
            return .drainNode(n, options: drainOpts)
        default:
            return action
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle().fill(accent.opacity(0.4)).frame(height: 1)
            body_content
            footer
        }
        .frame(width: 520)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(accent.opacity(0.5), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: action.isHighRisk ? "exclamationmark.triangle.fill" : "wrench.and.screwdriver.fill")
                .font(.system(size: 16))
                .foregroundStyle(accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(action.isHighRisk ? "Confirm destructive action" : "Confirm action")
                    .font(Theme.Font.body(14, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text(action.title)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
        .background(accent.opacity(0.08))
    }

    private var body_content: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(effectiveAction.subtitle)
                .font(Theme.Font.body(12))
                .foregroundStyle(Theme.Foreground.secondary)

            // Inline drain options.
            if case .drainNode = action {
                drainOptionsBlock
            }

            // Inline replica stepper for Scale.
            if case .scaleDeployment(let d, _) = action {
                let cur = d.spec?.replicas ?? d.status?.replicas ?? 0
                HStack(spacing: 10) {
                    Text("REPLICAS")
                        .font(Theme.Font.body(10, weight: .semibold))
                        .tracking(0.5)
                        .foregroundStyle(Theme.Foreground.tertiary)
                    Text("\(cur)")
                        .font(Theme.Font.mono(13))
                        .foregroundStyle(Theme.Foreground.tertiary)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.Foreground.tertiary)
                    Stepper(value: $replicas, in: 0...50) {
                        Text("\(replicas)")
                            .font(Theme.Font.mono(13, weight: .semibold))
                            .foregroundStyle(Theme.Foreground.primary)
                            .frame(minWidth: 24, alignment: .leading)
                    }
                    .labelsHidden()
                }
                .padding(10)
                .background(Theme.Surface.sunken)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("COMMAND")
                    .font(Theme.Font.body(10, weight: .semibold))
                    .tracking(0.5)
                    .foregroundStyle(Theme.Foreground.tertiary)
                Text(effectiveAction.previewCommand(context: contextName))
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(action.isHighRisk ? Theme.Status.failed : Theme.Foreground.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Theme.Surface.sunken)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md)
                            .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }

            if action.needsAcknowledge {
                Toggle(isOn: $acknowledged) {
                    Text("I understand this is destructive")
                        .font(Theme.Font.body(12))
                        .foregroundStyle(Theme.Status.failed)
                }
                .toggleStyle(.checkbox)
            }
        }
        .padding(18)
    }

    private var drainOptionsBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("OPTIONS")
                .font(Theme.Font.body(10, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)

            HStack(spacing: 12) {
                Label2(label: "Grace") {
                    Stepper(value: $drainOpts.gracePeriodSeconds, in: -1...3600) {
                        Text(drainOpts.gracePeriodSeconds < 0 ? "default" : "\(drainOpts.gracePeriodSeconds)s")
                            .font(Theme.Font.mono(11))
                            .foregroundStyle(Theme.Foreground.primary)
                            .frame(minWidth: 56, alignment: .leading)
                    }
                    .labelsHidden()
                }
                Label2(label: "Timeout") {
                    TextField("0s", text: $drainOpts.timeout)
                        .textFieldStyle(.plain)
                        .font(Theme.Font.mono(11))
                        .foregroundStyle(Theme.Foreground.primary)
                        .frame(width: 60)
                        .padding(.horizontal, 6).padding(.vertical, 3)
                        .background(Theme.Surface.sunken)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
            }

            optionToggle("Ignore DaemonSets", $drainOpts.ignoreDaemonSets,
                         help: "Skip pods owned by DaemonSets (usually required).")
            optionToggle("Delete emptyDir data", $drainOpts.deleteEmptyDirData,
                         help: "Allow eviction of pods using emptyDir volumes — data is lost.")
            optionToggle("Force", $drainOpts.force,
                         help: "Allow deletion of bare pods (not managed by a controller).")
            optionToggle("Disable eviction", $drainOpts.disableEviction,
                         help: "Use plain delete instead of eviction API. Bypasses PodDisruptionBudgets.")
        }
        .padding(12)
        .background(Theme.Surface.sunken)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private func optionToggle(_ label: String, _ binding: Binding<Bool>, help: String) -> some View {
        Toggle(isOn: binding) {
            Text(label)
                .font(Theme.Font.body(11))
                .foregroundStyle(Theme.Foreground.secondary)
        }
        .toggleStyle(.checkbox)
        .help(help)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Spacer()
            Button(action: onCancel) {
                Text("Cancel")
                    .font(Theme.Font.body(12, weight: .medium))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(Theme.Surface.sunken)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md)
                            .strokeBorder(Theme.Border.strong, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)

            Button { onApprove(effectiveAction) } label: {
                HStack(spacing: 6) {
                    if action.isHighRisk {
                        Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10))
                    }
                    Text(action.isHighRisk ? "Run anyway" : "Run")
                        .font(Theme.Font.body(12, weight: .semibold))
                }
                .foregroundStyle(Theme.Foreground.primary)
                .padding(.horizontal, 14).padding(.vertical, 7)
                .background(accent)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                .opacity((action.needsAcknowledge && !acknowledged) ? 0.4 : 1.0)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.defaultAction)
            .disabled(action.needsAcknowledge && !acknowledged)
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .background(Theme.Surface.primary)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }
}

/// Small inline "Label: control" row used inside the drain-options block.
private struct Label2<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: 6) {
            Text(label)
                .font(Theme.Font.body(10, weight: .semibold))
                .tracking(0.3)
                .foregroundStyle(Theme.Foreground.tertiary)
                .textCase(.uppercase)
            content
        }
    }
}
