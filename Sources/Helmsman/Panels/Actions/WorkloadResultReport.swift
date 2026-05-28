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

    private static func clip(_ s: String, fallback: String) -> String {
        if s.isEmpty { return fallback }
        return s.count > maxBody ? String(s.prefix(maxBody)) + "\n…(truncated)" : s
    }
}
