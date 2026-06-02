import Foundation

/// Builds the message fed back into the Claude session after an action Claude
/// proposed has been executed (with the user's approval) by Helmsman. This is
/// what closes the loop: claude proposes → helmsman runs → result returns to the
/// same claude session so it can verify and continue the task.
enum WorkloadResultReport {
    /// Cap piped output so a chatty command can't blow the context window.
    private static let maxBody = 4000

    static func chatFeedback(action: WorkloadAction, context: String?, result: WorkloadCommander.Result) -> String {
        let command = action.previewCommand(context: context)
        if result.ok {
            let out = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            return """
            [Helmsman executed the action you proposed — the user approved it.]
            Command:
            \(command)
            Status: success
            Output:
            \(clip(out, fallback: "(no output)"))

            Continue the task: if this completes what the user asked, confirm briefly; otherwise proceed with the next step.
            """
        } else {
            let err = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return """
            [Helmsman ran the action you proposed — the user approved it — but it FAILED.]
            Command:
            \(command)
            Exit code: \(result.exitCode)
            Error:
            \(clip(err, fallback: "(no stderr)"))

            Diagnose the failure and propose a corrected next step.
            """
        }
    }

    /// Single report for a queue of actions run back-to-back, so the assistant
    /// reacts once at the end instead of after every action. `skipped` lists
    /// queued actions that never ran because an earlier one failed.
    static func batchFeedback(
        ran: [(action: WorkloadAction, result: WorkloadCommander.Result)],
        skipped: [WorkloadAction],
        context: String?
    ) -> String {
        var lines: [String] = ["[Helmsman ran a queue of actions you proposed — the user approved and ran them together.]", ""]
        for (action, result) in ran {
            let cmd = action.previewCommand(context: context)
            if result.ok {
                let out = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                lines.append("• success: \(cmd)\n  output: \(clip(out, fallback: "(no output)"))")
            } else {
                let err = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                lines.append("• FAILED (exit \(result.exitCode)): \(cmd)\n  error: \(clip(err, fallback: "(no stderr)"))")
            }
        }
        if !skipped.isEmpty {
            lines.append("")
            lines.append("Stopped after a failure — these queued actions were NOT run:")
            for a in skipped { lines.append("• \(a.previewCommand(context: context))") }
        }
        lines.append("")
        lines.append(ran.contains { !$0.result.ok }
            ? "Diagnose the failure and propose a corrected next step for the remaining work."
            : "Continue the task: confirm completion briefly, or proceed with the next step.")
        return lines.joined(separator: "\n")
    }

    private static func clip(_ s: String, fallback: String) -> String {
        if s.isEmpty { return fallback }
        return s.count > maxBody ? String(s.prefix(maxBody)) + "\n…(truncated)" : s
    }
}
