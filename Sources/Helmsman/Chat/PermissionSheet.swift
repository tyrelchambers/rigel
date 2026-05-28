import SwiftUI

struct PermissionSheet: View {
    let pending: PendingPermission
    let onApprove: () -> Void
    let onDeny: () -> Void

    private static let destructivePattern = #/(?i)\b(delete|drain|destroy|rm\s+-rf|reset)\b/#

    private var isDestructive: Bool {
        (try? PermissionSheet.destructivePattern.firstMatch(in: pending.inputDescription)) != nil
    }

    private var accent: Color {
        isDestructive ? Theme.Status.failed : Theme.Accent.primary
    }

    @State private var acknowledged = false

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
            Image(systemName: isDestructive ? "exclamationmark.triangle.fill" : "wrench.and.screwdriver.fill")
                .font(.system(size: 16))
                .foregroundStyle(accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(isDestructive ? "Tool permission requested — destructive command" : "Tool permission requested")
                    .font(Theme.Font.body(14, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text(pending.toolName)
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
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("COMMAND")
                        .font(Theme.Font.body(10, weight: .semibold))
                        .tracking(0.5)
                        .foregroundStyle(Theme.Foreground.tertiary)
                    if isDestructive {
                        Text("matched destructive pattern: delete")
                            .font(Theme.Font.mono(9))
                            .foregroundStyle(Theme.Status.failed)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Theme.Status.failed.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    }
                }
                ScrollView {
                    Text(pending.inputDescription)
                        .font(Theme.Font.mono(12))
                        .foregroundStyle(isDestructive ? Theme.Status.failed : Theme.Foreground.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                }
                .frame(maxHeight: 140)
                .background(Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.md)
                        .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }

            if isDestructive {
                Toggle(isOn: $acknowledged) {
                    Text("I understand this looks destructive")
                        .font(Theme.Font.body(12))
                        .foregroundStyle(Theme.Status.failed)
                }
                .toggleStyle(.checkbox)
            }
        }
        .padding(18)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Spacer()
            Button(action: onDeny) {
                Text("Deny")
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
                HStack(spacing: 6) {
                    if isDestructive {
                        Image(systemName: "trash")
                            .font(.system(size: 11))
                    }
                    Text(isDestructive ? "Approve & run" : "Approve")
                        .font(Theme.Font.body(12, weight: .semibold))
                }
                .foregroundStyle(Theme.Foreground.primary)
                .padding(.horizontal, 14).padding(.vertical, 7)
                .background(accent)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                .opacity((isDestructive && !acknowledged) ? 0.4 : 1.0)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.defaultAction)
            .disabled(isDestructive && !acknowledged)
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .background(Theme.Surface.primary)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }
}
