import SwiftUI

/// The standard panel search box. Replaces the magnifier+TextField block that
/// was duplicated across every resource panel, and adds global-"/" focus: when
/// `SearchFocusController.shared.token` bumps (user pressed "/" outside any text
/// field), the field on the active panel takes focus.
struct PanelSearchField: View {
    @Binding var text: String
    var placeholder: String = "search"
    var maxWidth: CGFloat = 200

    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 10))
                .foregroundStyle(Theme.Foreground.tertiary)
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.primary)
                .focused($focused)
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Theme.Surface.sunken)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                .strokeBorder(focused ? Theme.Accent.primary.opacity(0.5) : Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        .frame(maxWidth: maxWidth)
        .onChange(of: SearchFocusController.shared.token) { _, _ in focused = true }
    }
}
