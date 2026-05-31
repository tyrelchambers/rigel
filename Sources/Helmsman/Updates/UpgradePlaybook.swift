import Foundation

/// The bundled upgrade playbook (`UpgradePlaybook.md`) and the turn it composes
/// for an upgrade. The playbook is static guidance; the per-app facts come from
/// an `UpgradePlan`. Kept separate so the markdown never needs templating.
enum UpgradePlaybook {
    /// The playbook text, loaded once from the app bundle. `nil` when the
    /// resource isn't present (e.g. `swift run` without bundled resources) — the
    /// caller degrades to a plain upgrade instruction and flags it.
    static let text: String? = {
        guard let url = Bundle.module.url(forResource: "UpgradePlaybook", withExtension: "md"),
              let s = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return s
    }()

    /// The full chat-turn text for an upgrade: the playbook followed by this
    /// run's concrete request. `playbookMissing` is true when the bundled
    /// playbook couldn't be loaded and only the request (plus a terse caution)
    /// was sent — surface that to the user rather than failing silently.
    static func upgradeMessage(for plan: UpgradePlan) -> (text: String, playbookMissing: Bool) {
        if let text {
            return ("\(text)\n\n---\n\n\(plan.contextBlock)", false)
        }
        return (
            "\(plan.contextBlock)\n\n(Upgrade playbook unavailable — proceed with standard caution: "
                + "confirm the app is healthy, check the changelog for breaking changes, apply via a setImage "
                + "action, watch the rollout, and offer a rollback if it fails.)",
            true
        )
    }
}
