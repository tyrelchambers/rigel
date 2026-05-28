import Foundation

enum SlashCommand: Equatable {
    case help
    case clear
    case investigate
    case logs(name: String?)
    case restart(name: String?)
    case describe(name: String?)

    /// Parse `/cmd arg...` from raw input. Returns nil if not a slash command.
    static func parse(_ text: String) -> SlashCommand? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("/") else { return nil }
        let body = trimmed.dropFirst()
        let parts = body.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard let head = parts.first else { return nil }
        let arg = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespaces) : nil
        let nameArg = (arg?.isEmpty ?? true) ? nil : arg

        switch head.lowercased() {
        case "help", "?":       return .help
        case "clear":           return .clear
        case "investigate":     return .investigate
        case "logs", "tail":    return .logs(name: nameArg)
        case "restart":         return .restart(name: nameArg)
        case "describe":        return .describe(name: nameArg)
        default:                return nil
        }
    }

    static let helpText: String = """
    Available slash commands:
    - `/help` — show this message
    - `/clear` — clear chat history
    - `/investigate` — ask Claude to audit cluster health
    - `/logs <deployment>` — open the Logs tab tailing that deployment
    - `/restart <deployment>` — restart a deployment via rollout restart
    - `/describe <pod-or-deployment>` — paste a kubectl describe into chat
    """
}
