import Foundation

/// Metadata for one chat command — the single source of truth that drives the
/// `/` typeahead popover, the commands button menu, and `/help`. Adding a
/// command means appending one spec here plus one dispatch case in
/// `SlashCommand.parse`.
struct ChatCommandSpec: Identifiable, Hashable {
    let name: String          // canonical, e.g. "logs"
    let aliases: [String]     // e.g. ["tail"]
    let description: String
    let argHint: String?      // e.g. "<deployment>"; nil = no argument

    var id: String { name }
    var allNames: [String] { [name] + aliases }
    /// Text inserted into the composer when picked from the popover/menu.
    var insertion: String { "/\(name) " }
    /// "/logs <deployment>" — for menu/popover display.
    var display: String { "/\(name)\(argHint.map { " \($0)" } ?? "")" }
}

enum ChatCommandRegistry {
    static let all: [ChatCommandSpec] = [
        .init(name: "help", aliases: ["?"], description: "Show available commands", argHint: nil),
        .init(name: "clear", aliases: [], description: "Clear the visible chat history", argHint: nil),
        .init(name: "investigate", aliases: [], description: "Audit cluster health", argHint: nil),
        .init(name: "logs", aliases: ["tail"], description: "Open the Logs tab tailing a deployment", argHint: "<deployment>"),
        .init(name: "restart", aliases: [], description: "Rollout-restart a deployment", argHint: "<deployment>"),
        .init(name: "describe", aliases: [], description: "Paste a kubectl describe into chat", argHint: "<pod|deployment>"),
    ]

    /// Spec for a command head (name or alias), case-insensitive.
    static func spec(forHead head: String) -> ChatCommandSpec? {
        let h = head.lowercased()
        return all.first { $0.allNames.contains(h) }
    }

    /// Commands matching a partial typed after the leading slash (empty → all).
    /// Ranks exact/prefix name matches above alias and description matches.
    static func filter(_ query: String) -> [ChatCommandSpec] {
        let q = query.lowercased()
        guard !q.isEmpty else { return all }
        func rank(_ s: ChatCommandSpec) -> Int? {
            if s.name == q { return 0 }
            if s.name.hasPrefix(q) { return 1 }
            if s.aliases.contains(where: { $0.hasPrefix(q) }) { return 2 }
            if s.description.lowercased().contains(q) { return 3 }
            return nil
        }
        return all.compactMap { s in rank(s).map { ($0, s) } }
            .sorted { $0.0 < $1.0 }
            .map { $0.1 }
    }
}

enum SlashCommand: Equatable {
    case help
    case clear
    case investigate
    case logs(name: String?)
    case restart(name: String?)
    case describe(name: String?)

    /// Parse `/cmd arg...` from raw input. Returns nil if not a known command.
    static func parse(_ text: String) -> SlashCommand? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("/") else { return nil }
        let body = trimmed.dropFirst()
        let parts = body.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard let head = parts.first.map(String.init),
              let spec = ChatCommandRegistry.spec(forHead: head) else { return nil }
        let arg = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespaces) : nil
        let nameArg = (arg?.isEmpty ?? true) ? nil : arg

        switch spec.name {
        case "help":        return .help
        case "clear":       return .clear
        case "investigate": return .investigate
        case "logs":        return .logs(name: nameArg)
        case "restart":     return .restart(name: nameArg)
        case "describe":    return .describe(name: nameArg)
        default:            return nil
        }
    }

    /// Generated from the registry so it never drifts from the actual commands.
    static var helpText: String {
        let lines = ChatCommandRegistry.all.map { spec -> String in
            let names = spec.allNames.map { "/\($0)" }.joined(separator: ", ")
            let arg = spec.argHint.map { " \($0)" } ?? ""
            return "- `\(names)\(arg)` — \(spec.description)"
        }
        return "Available slash commands:\n" + lines.joined(separator: "\n")
    }
}
