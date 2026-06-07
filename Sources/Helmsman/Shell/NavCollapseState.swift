import Foundation

/// Which sidebar nav groups are collapsed, keyed by group title. The pure logic
/// behind `NavStrip`'s disclosure behavior: no SwiftUI, no UserDefaults, so it
/// can be exercised in isolation. `NavStrip` persists it through `@AppStorage`
/// via the `storage` round-trip.
struct NavCollapseState {
    private(set) var collapsed: Set<String>

    func isCollapsed(_ title: String) -> Bool { collapsed.contains(title) }

    mutating func toggle(_ title: String) {
        if collapsed.contains(title) { collapsed.remove(title) }
        else { collapsed.insert(title) }
    }

    /// Expand the group that contains `panel`, so a selection landing in a
    /// collapsed group never leaves the highlighted row hidden. A no-op for a
    /// panel in the pinned (title-less) group or in an already-expanded group.
    mutating func reveal(panel: PanelKind) {
        guard let title = PanelKind.navGroups
            .first(where: { $0.panels.contains(panel) })?.title
        else { return }
        collapsed.remove(title)
    }

    /// Comma-joined titles for persistence. Group titles contain no commas, so
    /// this is unambiguous.
    var storage: String { collapsed.sorted().joined(separator: ",") }

    /// Every titled group collapsed — the first-launch default, so the sidebar
    /// starts compact. The pinned (title-less) group has no header and is left
    /// out, keeping Overview/Assistant visible.
    static var collapsedByDefault: NavCollapseState {
        NavCollapseState(storage: PanelKind.navGroups.compactMap(\.title).joined(separator: ","))
    }

    /// Tolerant decode: blanks are dropped, so `""` yields an empty set and a
    /// stale/renamed title in storage never wedges the state.
    init(storage: String) {
        self.collapsed = Set(
            storage
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
        )
    }
}
