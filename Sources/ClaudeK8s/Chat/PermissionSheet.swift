import SwiftUI

struct PermissionSheet: View {
    let pending: PendingPermission
    let onApprove: () -> Void
    let onDeny: () -> Void

    private static let destructivePattern = #/(?i)\b(delete|drain|destroy|rm\s+-rf|reset)\b/#

    private var isDestructive: Bool {
        (try? PermissionSheet.destructivePattern.firstMatch(in: pending.inputDescription)) != nil
    }

    @State private var acknowledged = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: isDestructive ? "exclamationmark.triangle.fill" : "wrench.and.screwdriver.fill")
                    .foregroundStyle(isDestructive ? .red : .blue)
                Text("Tool permission requested")
                    .font(.headline)
            }
            Text(pending.toolName).font(.title3).monospaced()
            ScrollView {
                Text(pending.inputDescription)
                    .font(.system(.caption, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 200)
            .background(Color(NSColor.controlBackgroundColor))
            .cornerRadius(6)

            if isDestructive {
                Toggle("I understand this looks destructive", isOn: $acknowledged)
                    .toggleStyle(.checkbox)
                    .foregroundStyle(.red)
            }

            HStack {
                Button("Deny", role: .cancel) { onDeny() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Approve") { onApprove() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(isDestructive && !acknowledged)
                    .buttonStyle(.borderedProminent)
                    .tint(isDestructive ? .red : .accentColor)
            }
        }
        .padding(20)
        .frame(width: 480)
    }
}
