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
            var args: [String] = []
            if let context { args.append(contentsOf: ["--context", context]) }
            args.append(contentsOf: inv.args)

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
