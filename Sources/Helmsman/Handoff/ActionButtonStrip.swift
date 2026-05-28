import SwiftUI

struct ActionButtonStrip<Action: Identifiable & Hashable>: View {
    let actions: [Action]
    let label: (Action) -> String
    let systemImage: (Action) -> String
    /// Default `.ask` — gives the same neutral chip these buttons have always
    /// had. `.execute` tints the icon + text in the accent color so executable
    /// actions read as "this will run" rather than "this asks Claude".
    var kind: (Action) -> ActionKind = { _ in .ask }
    let onTap: (Action) -> Void

    var body: some View {
        HStack(spacing: 4) {
            ForEach(actions) { action in
                button(for: action)
            }
        }
    }

    private func button(for action: Action) -> some View {
        let k = kind(action)
        let fg: Color = (k == .execute) ? Theme.Accent.primary : Theme.Foreground.secondary
        let tooltip: String = (k == .execute) ? label(action) : "Ask Claude: \(label(action))"
        return Button {
            onTap(action)
        } label: {
            HStack(spacing: 3) {
                Image(systemName: systemImage(action))
                    .font(.system(size: 9, weight: .medium))
                Text(label(action))
                    .font(Theme.Font.mono(10, weight: .medium))
            }
            .foregroundStyle(fg)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(Theme.Surface.elevated)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(k == .execute ? Theme.Accent.primary.opacity(0.4) : Theme.Border.subtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
        .help(tooltip)
    }
}
