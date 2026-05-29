import SwiftUI
import AppKit

/// Routes the global "/" hotkey to the active panel's search field.
///
/// A window-level key monitor watches for a bare "/" while no text field is
/// focused; when it fires it bumps `token`, which the active panel's
/// `PanelSearchField` observes to take focus. "/" typed inside any text field
/// (chat, a search box) is left alone so it types normally.
@Observable
final class SearchFocusController {
    @MainActor static let shared = SearchFocusController()

    /// Bumped each time "/" should focus the current tab's search.
    private(set) var token = 0

    @ObservationIgnored private var monitor: Any?

    func focusActiveSearch() { token &+= 1 }

    /// Install the local key monitor once (app lifetime).
    func startGlobalSlashShortcut() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            guard event.charactersIgnoringModifiers == "/",
                  event.modifierFlags.intersection([.command, .option, .control]).isEmpty else {
                return event
            }
            // If a text field/editor is first responder, let "/" type normally.
            if let r = NSApp.keyWindow?.firstResponder, r is NSText || r is NSTextView {
                return event
            }
            self.focusActiveSearch()
            return nil   // consume — don't beep / insert
        }
    }
}
