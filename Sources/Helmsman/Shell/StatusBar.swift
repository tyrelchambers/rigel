import SwiftUI

struct StatusBar: View {
    let context: String?
    let chatState: ChatState
    let podCount: Int
    let nodeCount: Int
    let cacheError: String?

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

            chip(label: "pods", value: "\(podCount)")
            chip(label: "nodes", value: "\(nodeCount)")

            Spacer()

            if cacheError != nil {
                HStack(spacing: 5) {
                    Circle().fill(Theme.Status.failed).frame(width: 5, height: 5)
                    Text("kubectl: error")
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Status.failed)
                }
                .help(cacheError ?? "")
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

            Text("⌘K")
                .font(Theme.Font.mono(9, weight: .medium))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 4).padding(.vertical, 1)
                .background(Theme.Surface.elevated)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                .help("Command palette")
        }
        .padding(.horizontal, 12)
        .frame(height: 22)
        .background(Theme.Surface.sunken)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
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
