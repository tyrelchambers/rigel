import Foundation

/// Detects whether the `kubectl cnpg` plugin is installed by running
/// `kubectl cnpg version`. Closures are injectable for testing; defaults use
/// the shared process helpers.
struct CNPGPluginProbe {
    var resolve: (_ name: String) -> String? = { resolveBinary($0) }
    var run: (_ binary: String, _ args: [String]) async throws -> Data = { bin, args in
        try await runProcess(bin, args: args)
    }

    func isAvailable() async -> Bool {
        guard let kubectl = resolve("kubectl") else { return false }
        do {
            _ = try await run(kubectl, ["cnpg", "version"])
            return true
        } catch {
            return false
        }
    }
}
