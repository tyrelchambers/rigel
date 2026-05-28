import Foundation

/// The Claude model Helmsman launches the `claude` CLI with. Raw values are the
/// CLI aliases passed to `--model`.
enum ClaudeModel: String, CaseIterable, Codable, Identifiable {
    case opus
    case sonnet
    case haiku

    var id: String { rawValue }

    /// Value passed to `claude --model`.
    var cliAlias: String { rawValue }

    /// Human-facing name shown in the picker.
    var displayName: String {
        switch self {
        case .opus:   return "Opus 4.8"
        case .sonnet: return "Sonnet 4.6"
        case .haiku:  return "Haiku 4.5"
        }
    }
}

/// Reasoning effort Helmsman launches the `claude` CLI with. Raw values match
/// the levels accepted by `claude --effort`.
enum ClaudeEffort: String, CaseIterable, Codable, Identifiable {
    case low
    case medium
    case high
    case xhigh
    case max

    var id: String { rawValue }

    /// Value passed to `claude --effort`.
    var cliLevel: String { rawValue }

    /// Human-facing name shown in the picker.
    var displayName: String {
        switch self {
        case .low:    return "Low"
        case .medium: return "Medium"
        case .high:   return "High"
        case .xhigh:  return "Extra high"
        case .max:    return "Max"
        }
    }
}

/// The model + effort a chat session runs with. Persisted globally in
/// SessionStore and applied as `--model`/`--effort` launch flags.
struct ClaudeModelConfig: Codable, Equatable {
    var model: ClaudeModel
    var effort: ClaudeEffort

    static let `default` = ClaudeModelConfig(model: .opus, effort: .high)

    /// Compact one-line label for the header menu, e.g. "Opus 4.8 · High".
    var shortLabel: String { "\(model.displayName) · \(effort.displayName)" }
}
