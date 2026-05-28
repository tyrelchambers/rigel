import SwiftUI

struct NavStrip: View {
    @Binding var selection: PanelKind

    var body: some View {
        VStack(spacing: 4) {
            ForEach(PanelKind.allCases) { kind in
                NavButton(kind: kind, isSelected: selection == kind) {
                    selection = kind
                }
            }
            Spacer()
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 6)
        .frame(width: 60)
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
            ZStack {
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .fill(isSelected ? Theme.Accent.primaryDim : Color.clear)
                Image(systemName: kind.icon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(isSelected ? Theme.Accent.primary : Theme.Foreground.tertiary)
            }
            .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .help(kind.title)
    }
}
