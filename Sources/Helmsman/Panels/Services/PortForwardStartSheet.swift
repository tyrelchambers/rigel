import SwiftUI

/// Small prompt for starting a port-forward. The local port is prefilled to the
/// service's remote port and editable. Only inline validation is done here
/// (numeric, not already tracked) — a real bind conflict surfaces afterward on
/// the forward's row, with no auto-bump.
struct PortForwardStartSheet: View {
    let targetKind: String   // "svc" | "pod"
    let targetName: String
    let namespace: String
    let remotePort: Int
    let isLocalPortInUse: (Int) -> Bool
    let onStart: (_ localPort: Int) -> Void
    let onCancel: () -> Void

    @State private var localPort: String

    init(
        targetKind: String,
        targetName: String,
        namespace: String,
        remotePort: Int,
        isLocalPortInUse: @escaping (Int) -> Bool,
        onStart: @escaping (_ localPort: Int) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.targetKind = targetKind
        self.targetName = targetName
        self.namespace = namespace
        self.remotePort = remotePort
        self.isLocalPortInUse = isLocalPortInUse
        self.onStart = onStart
        self.onCancel = onCancel
        _localPort = State(initialValue: String(remotePort))
    }

    private var parsedPort: Int? {
        let t = localPort.trimmingCharacters(in: .whitespaces)
        guard let n = Int(t), (1...65535).contains(n) else { return nil }
        return n
    }

    private var validationError: String? {
        guard let n = parsedPort else { return "Enter a port between 1 and 65535." }
        if isLocalPortInUse(n) { return "localhost:\(n) is already forwarded." }
        return nil
    }

    private var canSubmit: Bool { validationError == nil }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            VStack(alignment: .leading, spacing: 14) {
                Text("Forward a local port to **\(targetKind)/\(targetName):\(remotePort)** in namespace **\(namespace)**.")
                    .font(Theme.Font.body(12))
                    .foregroundStyle(Theme.Foreground.secondary)

                VStack(alignment: .leading, spacing: 4) {
                    Text("LOCAL PORT")
                        .font(Theme.Font.body(10, weight: .semibold)).tracking(0.3)
                        .foregroundStyle(Theme.Foreground.tertiary)
                    TextField("local port", text: $localPort)
                        .textFieldStyle(.plain)
                        .font(Theme.Font.mono(13))
                        .foregroundStyle(Theme.Foreground.primary)
                        .padding(.horizontal, 8).padding(.vertical, 6)
                        .background(Theme.Surface.sunken)
                        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                        .frame(width: 140)
                        .onSubmit { if canSubmit, let n = parsedPort { onStart(n) } }
                }

                if let err = validationError {
                    Text(err)
                        .font(Theme.Font.mono(11))
                        .foregroundStyle(Theme.Status.failed)
                }
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
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.strong, lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.left.arrow.right")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Accent.primary)
            Text("Port-forward")
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
                if let n = parsedPort { onStart(n) }
            } label: {
                Text("Start")
                    .font(Theme.Font.body(13, weight: .semibold))
                    .foregroundStyle(canSubmit ? Theme.Foreground.inverse : Theme.Foreground.tertiary)
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .background(canSubmit ? Theme.Accent.primary : Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit)
            .keyboardShortcut(.defaultAction)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }
}
