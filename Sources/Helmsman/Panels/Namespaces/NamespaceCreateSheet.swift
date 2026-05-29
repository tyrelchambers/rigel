import SwiftUI

/// Minimal "new namespace" prompt — just a DNS-1123 name. Hands the name back
/// via `onSubmit`; the caller submits `.createNamespace` through the confirm sheet.
struct NamespaceCreateSheet: View {
    let onSubmit: (_ name: String) -> Void
    let onCancel: () -> Void

    @State private var name: String = ""

    /// DNS-1123 label: lowercase alphanumerics and '-', must start/end alphanumeric.
    private var isValid: Bool {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard (1...63).contains(n.count) else { return false }
        let pattern = "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$"
        return n.range(of: pattern, options: .regularExpression) != nil
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            VStack(alignment: .leading, spacing: 12) {
                Text("Names use lowercase letters, digits, and hyphens (DNS-1123).")
                    .font(Theme.Font.body(12))
                    .foregroundStyle(Theme.Foreground.secondary)
                TextField("namespace name", text: $name)
                    .textFieldStyle(.plain)
                    .font(Theme.Font.mono(13))
                    .foregroundStyle(Theme.Foreground.primary)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .background(Theme.Surface.sunken)
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    .onSubmit { if isValid { onSubmit(name.trimmingCharacters(in: .whitespaces)) } }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Surface.sunken)
            Divider().background(Theme.Border.subtle)
            footer
        }
        .frame(width: 420)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.lg).strokeBorder(Theme.Border.strong, lineWidth: 1))
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "square.dashed")
                .font(.system(size: 13)).foregroundStyle(Theme.Accent.primary)
            Text("New Namespace")
                .font(Theme.Font.mono(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Spacer()
            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(width: 22, height: 22)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button("Cancel", action: onCancel)
                .buttonStyle(.plain)
                .font(Theme.Font.body(13))
                .foregroundStyle(Theme.Foreground.secondary)
                .padding(.horizontal, 12).padding(.vertical, 6)
            Button {
                onSubmit(name.trimmingCharacters(in: .whitespaces))
            } label: {
                Text("Create")
                    .font(Theme.Font.body(13, weight: .semibold))
                    .foregroundStyle(isValid ? Theme.Foreground.inverse : Theme.Foreground.tertiary)
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .background(isValid ? Theme.Accent.primary : Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .disabled(!isValid)
            .keyboardShortcut(.defaultAction)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }
}
