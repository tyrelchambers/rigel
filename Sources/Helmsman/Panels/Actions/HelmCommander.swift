import Foundation

/// Runs a Helm install for the catalog wizard. The argument vectors are built
/// from the `InstallDescriptor` + wizard-owned namespace/context/values — we
/// never execute Claude's free-form shell. Mirrors `WorkloadCommander`'s shape
/// but resolves the `helm` binary.
struct HelmCommander {
    struct Result {
        let stdout: String
        let stderr: String
        let exitCode: Int32
        var ok: Bool { exitCode == 0 }
    }

    let context: String?

    /// The ordered helm argument vectors (without the `helm` binary itself).
    /// Pure + testable. `repoName`/`repoURL`/`chart`/`releaseName` are required
    /// for helm mode; callers validate before invoking.
    static func commands(descriptor: InstallDescriptor, valuesPath: String, namespace: String, context: String?) -> [[String]] {
        let repoName = descriptor.repoName ?? ""
        let repoURL = descriptor.repoURL ?? ""
        let chart = descriptor.chart ?? ""
        let release = descriptor.releaseName ?? ""

        var upgrade: [String] = ["upgrade", "--install", release, "\(repoName)/\(chart)"]
        if let v = descriptor.version, !v.isEmpty { upgrade.append(contentsOf: ["--version", v]) }
        upgrade.append(contentsOf: ["-n", namespace, "--create-namespace", "-f", valuesPath])
        if let context, !context.isEmpty { upgrade.append(contentsOf: ["--kube-context", context]) }

        return [
            ["repo", "add", repoName, repoURL],
            ["repo", "update", repoName],
            upgrade,
        ]
    }

    /// Write `valuesYAML` to a temp file and run the helm command sequence,
    /// streaming combined stdout. `helm repo add` returning "already exists" is
    /// treated as success.
    func install(descriptor: InstallDescriptor, valuesYAML: String, namespace: String) async -> Result {
        guard let helm = resolveBinary("helm") else {
            return Result(stdout: "", stderr: "helm not found on PATH", exitCode: -1)
        }
        guard descriptor.mode == .helm,
              let repoName = descriptor.repoName, !repoName.isEmpty,
              descriptor.chart?.isEmpty == false,
              descriptor.releaseName?.isEmpty == false,
              descriptor.repoURL?.isEmpty == false else {
            return Result(stdout: "", stderr: "incomplete helm install descriptor", exitCode: -1)
        }
        _ = repoName

        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("helmsman-values-\(UUID().uuidString).yaml")
        do {
            try valuesYAML.write(to: tmp, atomically: true, encoding: .utf8)
        } catch {
            return Result(stdout: "", stderr: "couldn't write values file: \(error)", exitCode: -1)
        }
        defer { try? FileManager.default.removeItem(at: tmp) }

        var combined = ""
        let cmds = Self.commands(descriptor: descriptor, valuesPath: tmp.path, namespace: namespace, context: context)
        for (i, args) in cmds.enumerated() {
            do {
                let data = try await runProcess(helm, args: args)
                let out = String(data: data, encoding: .utf8) ?? ""
                if !out.isEmpty { combined += (combined.isEmpty ? "" : "\n") + out }
            } catch ProcessError.nonZeroExit(let code, let stderr) {
                // `repo add` (i == 0) is idempotent — an "already exists" failure is fine.
                if i == 0, stderr.localizedCaseInsensitiveContains("already exists") { continue }
                return Result(stdout: combined, stderr: stderr, exitCode: code)
            } catch {
                return Result(stdout: combined, stderr: "\(error)", exitCode: -1)
            }
        }
        return Result(stdout: combined, stderr: "", exitCode: 0)
    }
}
