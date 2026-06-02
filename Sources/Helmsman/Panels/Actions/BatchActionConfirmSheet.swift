import SwiftUI

/// Identifiable wrapper so a queue of actions can drive a `.sheet(item:)`.
struct BatchActions: Identifiable {
    let id = UUID()
    let actions: [WorkloadAction]
}

/// Confirm modal for a QUEUE of `WorkloadAction`s run back-to-back (the chat's
/// "Run selected" / execute-all). One review gate for the whole batch: lists
/// every command in order, then runs them sequentially (stopping at the first
/// failure). Single-action runs still go through `WorkloadConfirmSheet`.
struct BatchActionConfirmSheet: View {
    let actions: [WorkloadAction]
    let contextName: String?
    let onApprove: () -> Void
    let onCancel: () -> Void

    @State private var acknowledged = false

    private var anyHighRisk: Bool { actions.contains { $0.isHighRisk } }
    private var accent: Color { anyHighRisk ? Theme.Status.failed : Theme.Accent.primary }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            content
            footer
        }
        .frame(width: 600)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(accent.opacity(0.5), lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "list.bullet.rectangle")
                .font(.system(size: 14))
                .foregroundStyle(accent)
            VStack(alignment: .leading, spacing: 2) {
                Text("Run \(actions.count) action\(actions.count == 1 ? "" : "s") in order")
                    .font(Theme.Font.body(14, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("They run one after another; the queue stops at the first failure.")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
        .background(accent.opacity(0.08))
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(actions.enumerated()), id: \.offset) { idx, action in
                    HStack(alignment: .top, spacing: 8) {
                        Text("\(idx + 1)")
                            .font(Theme.Font.mono(10, weight: .semibold))
                            .foregroundStyle(Theme.Foreground.tertiary)
                            .frame(width: 16, alignment: .trailing)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 5) {
                                Image(systemName: action.isHighRisk ? "exclamationmark.triangle.fill" : "terminal")
                                    .font(.system(size: 9))
                                    .foregroundStyle(action.isHighRisk ? Theme.Status.failed : Theme.Foreground.tertiary)
                                Text(action.title)
                                    .font(Theme.Font.body(12, weight: .medium))
                                    .foregroundStyle(Theme.Foreground.primary)
                            }
                            Text(action.previewCommand(context: contextName))
                                .font(Theme.Font.mono(10))
                                .foregroundStyle(Theme.Foreground.secondary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }

                if anyHighRisk {
                    Toggle(isOn: $acknowledged) {
                        Text("I understand some of these are destructive and run without further prompts.")
                            .font(Theme.Font.body(11))
                            .foregroundStyle(Theme.Foreground.secondary)
                    }
                    .toggleStyle(.checkbox)
                    .padding(.top, 4)
                }
            }
            .padding(18)
        }
        .frame(maxHeight: 360)
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

            Button(action: onApprove) {
                Text("Run \(actions.count) in order")
                    .font(Theme.Font.body(12, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.inverse)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(canRun ? accent : Theme.Foreground.tertiary)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    .opacity(canRun ? 1.0 : 0.4)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.defaultAction)
            .disabled(!canRun)
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .background(Theme.Surface.primary)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var canRun: Bool {
        !actions.isEmpty && (!anyHighRisk || acknowledged)
    }
}
