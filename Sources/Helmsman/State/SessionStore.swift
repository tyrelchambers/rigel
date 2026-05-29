import Foundation

/// UI-message subset that can be encoded to disk. Tool invocations are flattened
/// to a single line so we don't try to round-trip rich `ToolInvocation` state.
struct PersistedMessage: Codable, Hashable {
    let role: String     // "user" | "assistant" | "system"
    let text: String
}

/// One past conversation. Auto-saved as the user talks; loaded into the active
/// chat on resume.
struct ChatHistoryEntry: Codable, Identifiable, Hashable {
    let id: UUID
    let context: String                // kubectl context this convo happened in
    var sessionId: String?             // claude session id (nil until first systemInit)
    let createdAt: Date
    var updatedAt: Date
    var title: String                  // derived from first user message
    var messages: [PersistedMessage]
}

@MainActor
final class SessionStore {
    static let shared = SessionStore()
    private let url: URL

    private struct Storage: Codable {
        var sessionsByContext: [String: String]
        var history: [ChatHistoryEntry] = []
        // Optional so existing sessions.json (written before this field existed)
        // still decodes; nil is treated as ClaudeModelConfig.default.
        var modelConfig: ClaudeModelConfig? = nil
        // Per-context right-sizing metrics source. Optional for back-compat.
        var metricsBackendByContext: [String: MetricsBackendConfig]? = nil
    }

    private var storage: Storage

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = support.appendingPathComponent("com.tyrelchambers.helmsman")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.url = dir.appendingPathComponent("sessions.json")

        if let data = try? Data(contentsOf: url),
           let s = try? JSONDecoder().decode(Storage.self, from: data) {
            self.storage = s
        } else {
            self.storage = Storage(sessionsByContext: [:])
        }
    }

    // MARK: - Active session id (per-context resume slot)

    func sessionId(for context: String) -> String? {
        storage.sessionsByContext[context]
    }

    func setSessionId(_ id: String, for context: String) {
        storage.sessionsByContext[context] = id
        persist()
    }

    func clearSessionId(for context: String) {
        storage.sessionsByContext.removeValue(forKey: context)
        persist()
    }

    // MARK: - Model / effort (global)

    /// The model + effort every chat launches with. Defaults to
    /// ClaudeModelConfig.default until the user picks otherwise.
    var modelConfig: ClaudeModelConfig {
        storage.modelConfig ?? .default
    }

    func setModelConfig(_ config: ClaudeModelConfig) {
        storage.modelConfig = config
        persist()
    }

    // MARK: - Metrics backend (per-context)

    /// The configured right-sizing source for a context, or `.local` if unset.
    func metricsBackend(for context: String) -> MetricsBackendConfig {
        storage.metricsBackendByContext?[context] ?? .local
    }

    func setMetricsBackend(_ config: MetricsBackendConfig, for context: String) {
        var map = storage.metricsBackendByContext ?? [:]
        map[context] = config
        storage.metricsBackendByContext = map
        persist()
    }

    // MARK: - History

    var history: [ChatHistoryEntry] {
        storage.history.sorted { $0.updatedAt > $1.updatedAt }
    }

    func upsertHistory(_ entry: ChatHistoryEntry) {
        if let idx = storage.history.firstIndex(where: { $0.id == entry.id }) {
            storage.history[idx] = entry
        } else {
            storage.history.append(entry)
        }
        // Cap at 100 most recent
        storage.history.sort { $0.updatedAt > $1.updatedAt }
        if storage.history.count > 100 {
            storage.history.removeLast(storage.history.count - 100)
        }
        persist()
    }

    func removeHistory(_ id: UUID) {
        storage.history.removeAll { $0.id == id }
        persist()
    }

    private func persist() {
        do {
            let data = try JSONEncoder().encode(storage)
            let tmp = url.appendingPathExtension("tmp")
            try data.write(to: tmp, options: .atomic)
            _ = try? FileManager.default.replaceItemAt(url, withItemAt: tmp)
        } catch {
            NSLog("SessionStore persist failed: \(error)")
        }
    }
}
