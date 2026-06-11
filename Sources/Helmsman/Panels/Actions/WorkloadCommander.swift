import Foundation

/// Executes user-approved `WorkloadAction`s via kubectl. Most callers route
/// through `WorkloadConfirmSheet`; wizard-style flows (e.g. the catalog
/// install wizard's Review step) that already gate approval in their own UI
/// may call `run` directly.
struct WorkloadCommander {
    struct Result {
        let stdout: String
        let stderr: String
        let exitCode: Int32
        var ok: Bool { exitCode == 0 }
    }

    let context: String?

    /// kubectl plugins (invoked as `kubectl <plugin> …`, e.g. cnpg) REJECT
    /// global flags placed before the plugin name ("flags cannot be placed
    /// before plugin name"). For those, `--context` must come AFTER the plugin
    /// name. Mirrors the web `buildKubectlArgs` (packages/k8s/src/run.ts).
    static let kubectlPlugins: Set<String> = ["cnpg"]

    /// Build the argv for one invocation, placing `--context` correctly for
    /// plugin vs. builtin commands.
    static func argv(context: String?, invocation args: [String]) -> [String] {
        guard let context else { return args }
        if let first = args.first, kubectlPlugins.contains(first) {
            return [first, "--context", context] + args.dropFirst()
        }
        return ["--context", context] + args
    }

    func run(_ action: WorkloadAction) async -> Result {
        guard let kubectl = resolveBinary("kubectl") else {
            return Result(stdout: "", stderr: "kubectl not found on PATH", exitCode: -1)
        }
        let invocations = action.kubectlInvocations()
        if invocations.isEmpty {
            return Result(stdout: "", stderr: "no-op action", exitCode: 0)
        }

        var combinedStdout = ""
        for inv in invocations {
            let args = Self.argv(context: context, invocation: inv.args)

            do {
                let data = try await runProcess(kubectl, args: args, stdin: inv.stdin)
                let out = String(data: data, encoding: .utf8) ?? ""
                if !out.isEmpty {
                    if !combinedStdout.isEmpty { combinedStdout += "\n" }
                    combinedStdout += out
                }
            } catch ProcessError.nonZeroExit(let code, let stderr) {
                return Result(stdout: combinedStdout, stderr: stderr, exitCode: code)
            } catch {
                return Result(stdout: combinedStdout, stderr: "\(error)", exitCode: -1)
            }
        }
        return Result(stdout: combinedStdout, stderr: "", exitCode: 0)
    }
}
