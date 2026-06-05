import SwiftUI

/// Structured confirm sheet for purging an entire app: a deselectable list of the
/// discovered resources, an opt-in (default-OFF) logical-DB drop, and a typed-name
/// confirmation that gates the destructive Purge button. Mirrors
/// `WorkloadConfirmSheet`'s destructive styling — this is the single review gate
/// before `PurgeExecutor` runs.
struct PurgeSheet: View {
    @State private var plan: PurgePlan
    @State private var confirmText = ""

    let onCancel: () -> Void
    let onConfirm: (PurgePlan) -> Void

    init(plan: PurgePlan, onCancel: @escaping () -> Void, onConfirm: @escaping (PurgePlan) -> Void) {
        _plan = State(initialValue: plan)
        self.onCancel = onCancel
        self.onConfirm = onConfirm
    }

    private let accent = Theme.Status.failed

    private var isBlocked: Bool { plan.blockedReason != nil }
    private var hasSelection: Bool { plan.resources.contains(where: \.selected) }
    private var nameConfirmed: Bool { confirmText == plan.appName }
    private var canPurge: Bool { !isBlocked && nameConfirmed && hasSelection }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle().fill(accent.opacity(0.4)).frame(height: 1)
            content
            footer
        }
        .frame(width: 560)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(accent.opacity(0.5), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "trash.fill")
                .font(.system(size: 16))
                .foregroundStyle(accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Purge \(plan.appName)")
                    .font(Theme.Font.body(14, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("namespace: \(plan.namespace)")
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
        .background(accent.opacity(0.08))
    }

    // MARK: - Content

    @ViewBuilder private var content: some View {
        if let reason = plan.blockedReason {
            blockedBody(reason)
        } else {
            VStack(alignment: .leading, spacing: 14) {
                Text("This permanently deletes the selected resources from the cluster. Deselect anything that should survive — the typed-name confirmation below is the real gate.")
                    .font(Theme.Font.body(12))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                resourceList

                if let hint = plan.databaseHint {
                    databaseBlock(hint: hint)
                }

                confirmBlock
            }
            .padding(18)
        }
    }

    private func blockedBody(_ reason: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.fill")
                .font(.system(size: 14))
                .foregroundStyle(Theme.Status.pending)
            Text(reason)
                .font(Theme.Font.body(12))
                .foregroundStyle(Theme.Foreground.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var resourceList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("RESOURCES")
                .font(Theme.Font.body(10, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)

            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach($plan.resources) { $resource in
                        Toggle(isOn: $resource.selected) {
                            HStack(spacing: 8) {
                                Text(resource.kind.rawValue)
                                    .font(Theme.Font.mono(9, weight: .semibold))
                                    .foregroundStyle(Theme.Accent.primary)
                                    .padding(.horizontal, 5).padding(.vertical, 1)
                                    .background(Theme.Accent.primaryDim)
                                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                                Text(resource.name)
                                    .font(Theme.Font.mono(11, weight: .medium))
                                    .foregroundStyle(Theme.Foreground.primary)
                                    .lineLimit(1).truncationMode(.middle)
                                Spacer(minLength: 0)
                            }
                        }
                        .toggleStyle(.checkbox)
                        .padding(.horizontal, 8).padding(.vertical, 5)
                    }
                }
                .padding(.vertical, 2)
            }
            .frame(maxHeight: 240)
            .background(Theme.Surface.sunken)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .strokeBorder(Theme.Border.subtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
    }

    /// Opt-in logical-DB drop. Visually distinct (failed-tinted) and default-OFF —
    /// dropping the database is irreversible and never bundled with the resource
    /// deletes above.
    private func databaseBlock(hint: String) -> some View {
        Toggle(isOn: $plan.dropDatabase) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Also drop database \(hint) — irreversible")
                    .font(Theme.Font.body(12, weight: .semibold))
                    .foregroundStyle(Theme.Status.failed)
                Text("Deletes the app's logical database inside the shared server. Off by default.")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .toggleStyle(.checkbox)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Status.failed.opacity(0.08))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .strokeBorder(Theme.Status.failed.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private var confirmBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("CONFIRM")
                .font(Theme.Font.body(10, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            TextField("type \(plan.appName) to confirm", text: $confirmText)
                .textFieldStyle(.plain)
                .font(Theme.Font.mono(12))
                .padding(.horizontal, 10).padding(.vertical, 8)
                .inputChrome(focused: nameConfirmed)
        }
    }

    // MARK: - Footer

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

            Button { onConfirm(plan) } label: {
                HStack(spacing: 6) {
                    Image(systemName: "trash.fill").font(.system(size: 10))
                    Text("Purge")
                        .font(Theme.Font.body(12, weight: .semibold))
                }
                .foregroundStyle(Theme.Foreground.primary)
                .padding(.horizontal, 14).padding(.vertical, 7)
                .background(accent)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                .opacity(canPurge ? 1.0 : 0.4)
            }
            .buttonStyle(.plain)
            // Deliberately NOT .defaultAction: the confirm gate is a text field,
            // so binding this destructive action to Return would let "type the
            // name + press Enter" purge the app in one motion, bypassing the
            // intended deliberate click. Return must do nothing here.
            .disabled(!canPurge)
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .background(Theme.Surface.primary)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }
}
