import Foundation

/// A multiple-choice clarifying question Claude raises in chat, parsed from a
/// fenced ```question JSON block in an assistant message. Rendered as a row of
/// option buttons; tapping one sends its answer back as the user's next message
/// so the model continues the conversation.
///
/// We route questions through this app-owned channel instead of Claude Code's
/// built-in `AskUserQuestion` tool: that tool needs the interactive TUI to draw
/// its picker and can't function in Helmsman's headless stream-json session
/// (it errored and the model fell back to prose). A fenced block we parse
/// ourselves works the same way the cluster-action buttons do.
struct ClarifyingQuestion: Identifiable, Decodable {
    let id: UUID
    /// The question prose shown above the option buttons.
    let question: String
    let options: [Option]

    struct Option: Identifiable, Decodable {
        let id: UUID
        /// Button text.
        let label: String
        /// Text sent back to Claude when this option is picked. Defaults to
        /// `label` when absent, so the model can have a richer answer sent than
        /// the short button shows.
        let value: String?

        /// What gets sent to Claude on tap.
        var answer: String { value ?? label }

        private enum CodingKeys: String, CodingKey { case label, value }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id = UUID()
            self.label = try c.decode(String.self, forKey: .label)
            self.value = try c.decodeIfPresent(String.self, forKey: .value)
        }
    }

    private enum CodingKeys: String, CodingKey { case question, options }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = UUID()
        self.question = try c.decode(String.self, forKey: .question)
        self.options = try c.decode([Option].self, forKey: .options)
    }

    /// Build the single message sent back to Claude when several question groups
    /// are answered together. Each answered group becomes a `>` blockquote with
    /// the full question prose followed by the chosen option's answer, in the
    /// order the groups appeared, blank-line separated. Groups with no selection
    /// are skipped (Submit gates on completeness, but the builder stays safe).
    static func combinedAnswer(questions: [ClarifyingQuestion], selections: [UUID: UUID]) -> String {
        questions.compactMap { question -> String? in
            guard let optionID = selections[question.id],
                  let option = question.options.first(where: { $0.id == optionID })
            else { return nil }
            return "> \(question.question)\n\(option.answer)"
        }
        .joined(separator: "\n\n")
    }
}
