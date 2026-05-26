import Foundation

@MainActor
final class SessionStore {
    static let shared = SessionStore()
    private let url: URL

    private struct Storage: Codable {
        var sessionsByContext: [String: String]  // context-name → claude session id
    }

    private var storage: Storage

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = support.appendingPathComponent("com.tyrelchambers.claude-k8s")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.url = dir.appendingPathComponent("sessions.json")

        if let data = try? Data(contentsOf: url),
           let s = try? JSONDecoder().decode(Storage.self, from: data) {
            self.storage = s
        } else {
            self.storage = Storage(sessionsByContext: [:])
        }
    }

    func sessionId(for context: String) -> String? {
        storage.sessionsByContext[context]
    }

    func setSessionId(_ id: String, for context: String) {
        storage.sessionsByContext[context] = id
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
