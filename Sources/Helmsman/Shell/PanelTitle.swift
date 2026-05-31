import SwiftUI

/// Standard panel header title: the tab name with a one-line descriptor
/// beneath it. Wording is sourced from `PanelKind` so it stays in one place
/// and matches the sidebar.
struct PanelTitle: View {
    let title: String
    let subtitle: String
    var titleFont: SwiftUI.Font = Theme.Font.body(15, weight: .semibold)

    init(_ kind: PanelKind) {
        title = kind.title
        subtitle = kind.subtitle
    }

    /// Escape hatch for panels whose title doesn't map 1:1 to a `PanelKind`
    /// (e.g. a larger title style).
    init(title: String, subtitle: String, titleFont: SwiftUI.Font = Theme.Font.body(15, weight: .semibold)) {
        self.title = title
        self.subtitle = subtitle
        self.titleFont = titleFont
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .font(titleFont)
                .foregroundStyle(Theme.Foreground.primary)
            Text(subtitle)
                .font(Theme.Font.body(11))
                .foregroundStyle(Theme.Foreground.tertiary)
        }
    }
}
