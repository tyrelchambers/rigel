import SwiftUI

struct NavStrip: View {
    @Binding var selection: PanelKind

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(PanelKind.navGroups) { group in
                    if let title = group.title {
                        Text(title.uppercased())
                            .font(Theme.Font.body(10, weight: .semibold))
                            .foregroundStyle(Theme.Foreground.tertiary)
                            .padding(.horizontal, 12)
                            .padding(.top, 14)
                            .padding(.bottom, 2)
                    }
                    ForEach(group.panels) { kind in
                        NavButton(kind: kind, isSelected: selection == kind) {
                            selection = kind
                        }
                    }
                }
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 8)
        }
        .frame(width: 184)
        .frame(maxHeight: .infinity)
        .background(Theme.Surface.sunken)
        .overlay(alignment: .trailing) {
            Rectangle().fill(Theme.Border.subtle).frame(width: 1)
        }
    }
}

private struct NavButton: View {
    let kind: PanelKind
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: kind.icon)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(isSelected ? Theme.Accent.primary : Theme.Foreground.tertiary)
                    .frame(width: 20)
                Text(kind.title)
                    .font(Theme.Font.body(13, weight: isSelected ? .semibold : .medium))
                    .foregroundStyle(isSelected ? Theme.Foreground.primary : Theme.Foreground.secondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .fill(isSelected ? Theme.Accent.primaryDim : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(kind.title)
    }
}
