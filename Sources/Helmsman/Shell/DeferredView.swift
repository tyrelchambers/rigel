import SwiftUI

/// Mounts heavy content one runloop tick after appearing, so navigating to a
/// data-heavy tab paints the surrounding chrome immediately instead of blocking
/// the switch on the list's first layout. The brief gap shows `placeholder`.
///
/// When `isDeferred` is false the content renders immediately (no flash) — used
/// for light panels. Apply `.id(...)` keyed on the selection so each switch is a
/// fresh identity that re-defers.
struct DeferredView<Content: View, Placeholder: View>: View {
    var isDeferred: Bool = true
    @ViewBuilder var content: () -> Content
    @ViewBuilder var placeholder: () -> Placeholder

    @State private var mounted = false

    var body: some View {
        Group {
            if mounted || !isDeferred {
                content()
            } else {
                placeholder()
            }
        }
        .task {
            guard isDeferred, !mounted else { return }
            // Yield so the switch's chrome commits this frame; the heavy list then
            // builds on the next runloop pass.
            await Task.yield()
            mounted = true
        }
    }
}

/// Neutral placeholder shown for the one tick before a heavy panel mounts.
struct PanelLoading: View {
    var body: some View {
        ProgressView()
            .controlSize(.small)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.Surface.primary)
    }
}
