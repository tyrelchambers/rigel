import Foundation

/// Live state of one of the install's pods, for the handoff context.
struct InstallPodState: Equatable {
    let name: String
    let phase: String
    let ready: Bool
    let restarts: Int
    /// CrashLoopBackOff / Error / etc. when unhealthy; nil when fine.
    let reason: String?
}

/// Builds the prompt + breadcrumb that hand an unfinished install off to the
/// main-chat Helmsman, with live cluster state and the finish-loop contract.
///
/// SAFETY: the applied manifest carries real secret values, so it is redacted
/// before it ever reaches the chat transcript / model context.
enum InstallFinishPrompt {

    /// Mask every value inside a `Secret`'s `data:`/`stringData:` block so secret
    /// material never enters the prompt. Non-Secret documents are untouched.
    static func redactSecrets(_ yaml: String) -> String {
        var out: [String] = []
        var inSecret = false
        var dataIndent: Int? = nil
        for line in yaml.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let indent = line.prefix { $0 == " " }.count
            if trimmed == "---" { inSecret = false; dataIndent = nil; out.append(line); continue }
            if isTopLevelKey(line, "kind") {
                inSecret = trimmed.dropFirst("kind:".count).trimmingCharacters(in: .whitespaces) == "Secret"
                dataIndent = nil; out.append(line); continue
            }
            if inSecret, trimmed == "data:" || trimmed == "stringData:" {
                dataIndent = indent; out.append(line); continue
            }
            if inSecret, let di = dataIndent {
                if indent > di {
                    if let colon = trimmed.firstIndex(of: ":") {
                        let key = trimmed[..<colon]
                        out.append(String(repeating: " ", count: indent) + key + ": ••••redacted••••")
                        continue
                    }
                } else if !trimmed.isEmpty {
                    dataIndent = nil   // dedented out of the data block
                }
            }
            out.append(line)
        }
        return out.joined(separator: "\n")
    }

    private static func isTopLevelKey(_ line: String, _ key: String) -> Bool {
        line.hasPrefix("\(key):") || line.hasPrefix("  \(key):")
    }

    /// The hidden context prompt + the one-line breadcrumb shown in the transcript.
    static func build(
        appName: String,
        scope: InstallScope,
        hostname: String,
        exposesIngress: Bool,
        manifestYAML: String,
        pods: [InstallPodState],
        events: [String],
        failingLogs: [(pod: String, tail: String)],
        notes: String
    ) -> (prompt: String, breadcrumb: String) {
        let unhealthy = pods.filter { !$0.ready || $0.reason != nil }
        let breadcrumb = "Finishing \(appName) install — \(unhealthy.count) component(s) not ready; handing to the Helmsman"

        let podTable = pods.map {
            "  - \($0.name): phase=\($0.phase) ready=\($0.ready) restarts=\($0.restarts)\($0.reason.map { " reason=\($0)" } ?? "")"
        }.joined(separator: "\n")
        let eventLines = events.isEmpty ? "  (none)" : events.map { "  - \($0)" }.joined(separator: "\n")
        let logBlocks = failingLogs.map { "### logs: \($0.pod)\n```\n\($0.tail)\n```" }.joined(separator: "\n\n")
        let reach = exposesIngress
            ? "all pods Ready AND the app answers over its host (HTTP 200 at https://\(hostname)) AND its TLS cert has issued"
            : "all pods Ready AND the app answers on its Service"

        let prompt = """
        You're finishing a catalog install that didn't come up clean on its own. Drive it to a
        working state, then stop.

        ## App
        \(appName) — namespace `\(scope.namespace)`, instance `\(scope.instance)`, host `\(hostname)`.
        Notes: \(notes.isEmpty ? "(none)" : notes)

        ## Definition of done
        \(reach). When you reach it, say so and stop. If you can't after a few rounds of fixes,
        STOP and summarize what you tried, what's still broken, and what you need from the operator —
        do not loop indefinitely.

        ## How to act (important)
        Propose each fix as a ```action block. Fixes that are LOW-RISK and scoped to THIS install
        (namespace `\(scope.namespace)`, resources named `\(scope.instance)`/`\(scope.instance)-*`)
        run automatically — e.g. setEnv, rollout restart, scale-up, and `command` annotate/label/
        patch/set. Anything destructive (delete, scale-to-0, image change), node-wide, or touching
        another app or namespace will ask the operator to confirm — so keep fixes tightly scoped to
        this install and never touch neighbours sharing `\(scope.namespace)`.

        ## Current state
        Pods:
        \(podTable.isEmpty ? "  (none found)" : podTable)

        Recent events:
        \(eventLines)

        \(logBlocks.isEmpty ? "" : logBlocks)

        ## Applied manifest (secret values redacted)
        ```yaml
        \(redactSecrets(manifestYAML))
        ```
        """
        return (prompt, breadcrumb)
    }
}
