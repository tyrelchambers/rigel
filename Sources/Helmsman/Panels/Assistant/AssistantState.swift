import Foundation

/// Swift mirror of the in-cluster agent's `state.json` (written to the
/// `assistant-state` ConfigMap). Decode-only — Helmsman reads this surface; the
/// agent owns writing it. Field names match the agent's camelCase keys exactly.
struct AssistantClusterState: Decodable {
    var updatedAt: String?
    var status: AssistantAgentStatus?
    var audit: [AssistantAuditEntry]
    var queue: [AssistantQueuedSuggestion]
    var report: String

    enum CodingKeys: String, CodingKey {
        case updatedAt, status, audit, queue, report
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        status = try c.decodeIfPresent(AssistantAgentStatus.self, forKey: .status)
        audit = try c.decodeIfPresent([AssistantAuditEntry].self, forKey: .audit) ?? []
        queue = try c.decodeIfPresent([AssistantQueuedSuggestion].self, forKey: .queue) ?? []
        report = try c.decodeIfPresent(String.self, forKey: .report) ?? ""
    }
}

struct AssistantAgentStatus: Decodable {
    var heartbeatAt: String
    var spentUsd: Double
    var spendCapUsd: Double
    var enabled: Bool
    var version: String
}

struct AssistantAuditEntry: Decodable, Identifiable {
    var at: String
    var fingerprint: String
    var incident: String
    var proposal: String?
    var command: String?
    var tier: String
    var verdict: String?
    var outcome: String
    var detail: String
    var backupRef: String?

    var id: String { "\(at)|\(fingerprint)|\(proposal ?? "")|\(outcome)" }
}

struct AssistantQueuedSuggestion: Decodable, Identifiable {
    var at: String
    var incident: String
    var suggestion: String
    var reason: String
    var action: SuggestedAction?

    var id: String { "\(at)|\(incident)|\(suggestion)" }
}
