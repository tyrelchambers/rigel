import Foundation

/// What pressing a resource-action button does. `.ask` builds a context-handoff
/// prompt and routes it to Claude; `.execute` fires a kubectl WorkloadAction
/// directly (still gated by the confirm sheet). The button strip uses this to
/// tint executable buttons with a subtle accent.
enum ActionKind {
    case ask
    case execute
}

enum DeploymentAction: String, CaseIterable, Identifiable {
    case errors, logs, explain, rollout

    var id: String { rawValue }

    var label: String {
        switch self {
        case .errors:  return "Errors"
        case .logs:    return "Logs"
        case .explain: return "Explain"
        case .rollout: return "Rollout"
        }
    }

    var systemImage: String {
        switch self {
        case .errors:  return "exclamationmark.triangle"
        case .logs:    return "text.alignleft"
        case .explain: return "questionmark.circle"
        case .rollout: return "clock.arrow.circlepath"
        }
    }

    var kind: ActionKind {
        switch self {
        case .rollout: return .execute
        default:       return .ask
        }
    }
}

enum PodAction: String, CaseIterable, Identifiable {
    case errors, logs, explain, whyNotReady

    var id: String { rawValue }

    var label: String {
        switch self {
        case .errors:      return "Errors"
        case .logs:        return "Logs"
        case .explain:     return "Explain"
        case .whyNotReady: return "Why not ready?"
        }
    }

    var systemImage: String {
        switch self {
        case .errors:      return "exclamationmark.triangle"
        case .logs:        return "text.alignleft"
        case .explain:     return "questionmark.circle"
        case .whyNotReady: return "stethoscope"
        }
    }

    /// All pod actions currently route to Claude.
    var kind: ActionKind { .ask }
}
