import SwiftUI

struct StatusBar: View {
    /// Read pod/node counts, the kubectl error and the live chat state here (in
    /// this tiny view) rather than in MainWindow's body, so the high-frequency
    /// pod/node watches and per-token chat streaming don't re-evaluate the whole
    /// window (and rebuild the active panel).
    let cache: ClusterCache
    let context: String?
    let chat: ChatViewModel
    var onOpenPalette: () -> Void = {}

    /// Derived locally so reading `chat.isStreaming`/`messages`/`error` subscribes
    /// this status bar, not MainWindow.
    private var chatState: ChatState {
        if chat.error != nil && chat.messages.contains(where: { $0.text.contains("no longer running") }) {
            return .dead
        }
        return chat.isStreaming ? .streaming : .idle
    }

    enum ChatState {
        case idle, streaming, dead
        var label: String {
            switch self {
            case .idle:      return "idle"
            case .streaming: return "streaming"
            case .dead:      return "stopped"
            }
        }
        var color: Color {
            switch self {
            case .idle:      return Theme.Status.running
            case .streaming: return Theme.Accent.primary
            case .dead:      return Theme.Status.failed
            }
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            Label {
                Text(context ?? "no context")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.secondary)
            } icon: {
                Image(systemName: "network")
                    .font(.system(size: 9))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }

            chip(label: "pods", value: "\(cache.pods.count)")
            chip(label: "nodes", value: "\(cache.nodes.count)")

            Spacer()

            if let cacheError = cache.error {
                HStack(spacing: 5) {
                    Circle().fill(Theme.Status.failed).frame(width: 5, height: 5)
                    Text("kubectl: error")
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Status.failed)
                }
                .help(cacheError)
            } else {
                HStack(spacing: 5) {
                    Circle().fill(Theme.Status.running).frame(width: 5, height: 5)
                    Text("kubectl: ok")
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
            }

            HStack(spacing: 5) {
                Circle().fill(chatState.color).frame(width: 5, height: 5)
                Text("claude: \(chatState.label)")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }

            // Shortcut callouts — so the key bindings stay discoverable.
            Button(action: onOpenPalette) {
                shortcut(key: "⌘K", label: "Commands")
            }
            .buttonStyle(.plain)
            .help("Open the command palette")
            shortcut(key: "/", label: "Search")
                .help("Search the current tab")
            shortcut(key: "⌘L", label: "Chat")
                .help("Focus the Claude chat input")
        }
        .padding(.horizontal, 12)
        .frame(height: 22)
        .background(Theme.Surface.sunken)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    /// A "⌘K Commands"-style shortcut hint: keycap chip + label.
    private func shortcut(key: String, label: String) -> some View {
        HStack(spacing: 4) {
            Text(key)
                .font(Theme.Font.mono(9, weight: .medium))
                .foregroundStyle(Theme.Foreground.secondary)
                .padding(.horizontal, 4).padding(.vertical, 1)
                .background(Theme.Surface.elevated)
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Text(label)
                .font(Theme.Font.mono(9))
                .foregroundStyle(Theme.Foreground.tertiary)
        }
    }

    private func chip(label: String, value: String) -> some View {
        HStack(spacing: 4) {
            Text(label)
                .font(Theme.Font.mono(9))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text(value)
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(Theme.Foreground.secondary)
        }
    }
}
