import SwiftUI

/// Pick a new name and/or namespace for a Secret. Submitting fires a
/// `.moveSecret` WorkloadAction (apply-new + delete-old) through the normal
/// confirm sheet, which is where the user finally clicks Run.
struct SecretMoveSheet: View {
    let secret: Secret
    let onSubmit: (_ newName: String, _ newNamespace: String) -> Void
    let onCancel: () -> Void

    @State private var newName: String
    @State private var newNamespace: String

    init(secret: Secret, onSubmit: @escaping (String, String) -> Void, onCancel: @escaping () -> Void) {
        self.secret = secret
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        _newName = State(initialValue: secret.metadata.name)
        _newNamespace = State(initialValue: secret.metadata.namespace ?? "default")
    }

    private var oldNs: String { secret.metadata.namespace ?? "default" }
    private var oldName: String { secret.metadata.name }

    private var isUnchanged: Bool {
        newName.trimmingCharacters(in: .whitespacesAndNewlines) == oldName &&
        newNamespace.trimmingCharacters(in: .whitespacesAndNewlines) == oldNs
    }

    private var canSubmit: Bool {
        !newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !newNamespace.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !isUnchanged
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            body_content
            footer
        }
        .frame(width: 520)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Status.pending.opacity(0.5), lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.left.arrow.right")
                .font(.system(size: 14))
                .foregroundStyle(Theme.Status.pending)
            VStack(alignment: .leading, spacing: 2) {
                Text("Move secret")
                    .font(Theme.Font.body(14, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("\(oldNs)/\(oldName)")
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 18).padding(.vertical, 14)
        .background(Theme.Status.pending.opacity(0.08))
    }

    private var body_content: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Pick a new name and/or namespace. The secret is copied to the new location, then deleted from the old one. Workloads referencing the old name/namespace will fail until you update them.")
                .font(Theme.Font.body(12))
                .foregroundStyle(Theme.Foreground.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 6) {
                Text("NEW NAME")
                    .font(Theme.Font.body(10, weight: .semibold))
                    .tracking(0.3)
                    .foregroundStyle(Theme.Foreground.tertiary)
                TextField(oldName, text: $newName)
                    .textFieldStyle(.plain)
                    .font(Theme.Font.mono(12))
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(Theme.Surface.sunken)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.sm)
                            .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("NEW NAMESPACE")
                    .font(Theme.Font.body(10, weight: .semibold))
                    .tracking(0.3)
                    .foregroundStyle(Theme.Foreground.tertiary)
                TextField(oldNs, text: $newNamespace)
                    .textFieldStyle(.plain)
                    .font(Theme.Font.mono(12))
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(Theme.Surface.sunken)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.sm)
                            .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }

            if isUnchanged {
                Text("Name and namespace are unchanged — nothing to do.")
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
        }
        .padding(18)
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

            Button {
                onSubmit(
                    newName.trimmingCharacters(in: .whitespacesAndNewlines),
                    newNamespace.trimmingCharacters(in: .whitespacesAndNewlines)
                )
            } label: {
                Text("Next…")
                    .font(Theme.Font.body(12, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.inverse)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(canSubmit ? Theme.Status.pending : Theme.Foreground.tertiary)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    .opacity(canSubmit ? 1.0 : 0.4)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.defaultAction)
            .disabled(!canSubmit)
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .background(Theme.Surface.primary)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }
}
