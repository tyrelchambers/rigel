import Foundation

/// The `claude setup-token` OAuth token is valid for one year. If it lapses the
/// agent silently goes dark (claude -p fails → everything fail-closes to
/// "queued"), so the Assistant tab surfaces a countdown and warns before expiry.
enum TokenExpiry {
    static let lifetimeDays = 365
    static let warnWithinDays = 30
    /// Annotation the installer stamps on the token Secret at mint time.
    static let issuedAtAnnotation = "helmsman.assistant/token-issued-at"

    enum Level: Equatable { case ok, warning, expired }

    struct Status: Equatable {
        let daysRemaining: Int
        let level: Level
    }

    static func status(issuedAt: Date, now: Date) -> Status {
        let expiry = issuedAt.addingTimeInterval(Double(lifetimeDays) * 86_400)
        let remaining = Int((expiry.timeIntervalSince(now) / 86_400).rounded(.down))
        let level: Level
        if remaining <= 0 {
            level = .expired
        } else if remaining <= warnWithinDays {
            level = .warning
        } else {
            level = .ok
        }
        return Status(daysRemaining: remaining, level: level)
    }
}
