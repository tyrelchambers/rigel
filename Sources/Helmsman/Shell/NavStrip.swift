import SwiftUI

struct NavStrip: View {
    @Binding var selection: PanelKind
    @AppStorage("nav.collapsedGroups") private var collapsedRaw = ""

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(PanelKind.navGroups) { group in
                    let collapse = NavCollapseState(storage: collapsedRaw)
                    if let title = group.title {
                        let isCollapsed = collapse.isCollapsed(title)
                        NavGroupHeader(title: title, isCollapsed: isCollapsed) {
                            withAnimation(.easeInOut(duration: 0.18)) {
                                var next = NavCollapseState(storage: collapsedRaw)
                                next.toggle(title)
                                collapsedRaw = next.storage
                            }
                        }
                        if !isCollapsed {
                            navButtons(for: group)
                        }
                    } else {
                        navButtons(for: group)
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
        .onChange(of: selection) {
            // A selection landing in a collapsed group (⌘K, deep link) pops it open.
            var next = NavCollapseState(storage: collapsedRaw)
            next.reveal(panel: selection)
            if next.storage != collapsedRaw {
                withAnimation(.easeInOut(duration: 0.18)) { collapsedRaw = next.storage }
            }
        }
    }

    private func navButtons(for group: PanelKind.NavGroup) -> some View {
        ForEach(group.panels) { kind in
            NavButton(kind: kind, isSelected: selection == kind) {
                selection = kind
            }
        }
    }
}

/// Tappable section header for a titled nav group: the existing uppercased label
/// plus a chevron that reflects and toggles its collapsed state.
private struct NavGroupHeader: View {
    let title: String
    let isCollapsed: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title.uppercased())
                    .font(Theme.Font.body(10, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
                Spacer(minLength: 0)
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.top, 14)
            .padding(.bottom, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(isCollapsed ? "Expand \(title)" : "Collapse \(title)")
    }
}

private struct NavButton: View {
    let kind: PanelKind
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovered = false

    /// Selected wins; otherwise a subtle fill on hover so the row reads as
    /// interactive without competing with the selection highlight.
    private var fill: Color {
        if isSelected { return Theme.Accent.primaryDim }
        return isHovered ? Theme.Surface.elevated : Color.clear
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: kind.icon)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(isSelected ? Theme.Accent.primary : (isHovered ? Theme.Foreground.secondary : Theme.Foreground.tertiary))
                    .frame(width: 20)
                Text(kind.title)
                    .font(Theme.Font.body(13, weight: isSelected ? .semibold : .medium))
                    .foregroundStyle(isSelected || isHovered ? Theme.Foreground.primary : Theme.Foreground.secondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .fill(fill)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovered)
        .help(kind.title)
    }
}
