import Foundation

/// Installs the `kubectl-cnpg` plugin on the user's machine using CloudNativePG's
/// official install script, dropping the binary next to the resolved `kubectl`
/// (same directory → already on PATH, where kubectl discovers `kubectl-<name>`
/// plugins). Closures are injectable for testing.
///
/// The web app bakes the plugin into its container image instead (it runs
/// kubectl server-side); on the desktop the plugin must live on the user's PATH,
/// so we offer a one-click install when it's missing.
struct CNPGPluginInstaller {
    static let scriptURL =
        "https://github.com/cloudnative-pg/cloudnative-pg/raw/main/hack/install-cnpg-plugin.sh"

    var resolve: (_ name: String) -> String? = { resolveBinary($0) }
    var run: (_ launchPath: String, _ args: [String]) async throws -> Data = { bin, args in
        try await runProcess(bin, args: args)
    }

    /// The `/bin/sh -c` argv that pipes the official installer to `sh`, targeting
    /// `binDir`. Pure + deterministic so it can be unit-tested.
    static func installArgv(binDir: String) -> [String] {
        ["-c", "curl -sSfL \(scriptURL) | sh -s -- -b \(binDir)"]
    }

    func install() async -> (ok: Bool, output: String) {
        guard let kubectl = resolve("kubectl") else {
            return (false, "kubectl not found on PATH")
        }
        let binDir = URL(fileURLWithPath: kubectl).deletingLastPathComponent().path
        do {
            let data = try await run("/bin/sh", Self.installArgv(binDir: binDir))
            return (true, String(data: data, encoding: .utf8) ?? "")
        } catch ProcessError.nonZeroExit(_, let stderr) {
            return (false, stderr)
        } catch {
            return (false, "\(error)")
        }
    }
}
