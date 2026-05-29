import SwiftUI

/// Slash-command typeahead, shown when the composer holds a leading `/token`.
/// Mirrors `MentionPopover`; reads its list from `ChatCommandRegistry`.
struct CommandPopover: View {
    let commands: [ChatCommandSpec]
    let selectedIndex: Int
    let onPick: (ChatCommandSpec) -> Void

    var body: some View {
        if commands.isEmpty {
            EmptyView()
        } else {
            VStack(spacing: 1) {
                ForEach(Array(commands.enumerated()), id: \.element.id) { idx, spec in
                    row(spec, isSelected: idx == selectedIndex)
                }
            }
            .padding(4)
            .background(Theme.Surface.elevated)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .strokeBorder(Theme.Border.strong, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            .shadow(color: .black.opacity(0.4), radius: 12, y: 4)
        }
    }

    private func row(_ spec: ChatCommandSpec, isSelected: Bool) -> some View {
        Button { onPick(spec) } label: {
            HStack(spacing: 8) {
                Image(systemName: "terminal")
                    .font(.system(size: 10))
                    .foregroundStyle(isSelected ? Theme.Foreground.inverse : Theme.Foreground.secondary)
                    .frame(width: 14)
                Text(spec.display)
                    .font(Theme.Font.mono(12, weight: .medium))
                    .foregroundStyle(isSelected ? Theme.Foreground.inverse : Theme.Foreground.primary)
                    .lineLimit(1)
                Text(spec.description)
                    .font(Theme.Font.body(11))
                    .foregroundStyle(isSelected ? Theme.Foreground.inverse.opacity(0.8) : Theme.Foreground.tertiary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(isSelected ? Theme.Accent.primary : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }
}
