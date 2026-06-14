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

    /// A named free-text input attached to an option. The user's typed text maps
    /// to the AI's variable (`name`), so the model knows which slot was filled.
    /// See docs/parity/chat-input-fields.md § 2. This is the Swift twin of the
    /// web `QuestionField` interface in `packages/k8s/src/actionBlocks.ts`.
    struct Field: Identifiable, Decodable {
        let id: UUID
        /// The AI's variable name. The user's typed text maps to it. Taken
        /// verbatim — no dedupe/trim/coercion.
        let name: String
        /// Human label shown beside the field. Defaults to `name` at render time.
        let label: String?
        /// Example/hint text inside the input.
        let placeholder: String?
        /// Whether the field must be filled before submit. Defaults to **true**
        /// when absent or non-boolean.
        let required: Bool

        /// Label to render — falls back to `name` when no explicit label given.
        var displayLabel: String { label ?? name }

        private enum CodingKeys: String, CodingKey { case name, label, placeholder, required }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id = UUID()
            // `name` is mandatory; a field lacking a string `name` throws and is
            // dropped by the lossy option decoder.
            self.name = try c.decode(String.self, forKey: .name)
            self.label = try c.decodeIfPresent(String.self, forKey: .label)
            self.placeholder = try c.decodeIfPresent(String.self, forKey: .placeholder)
            // Kept only when an explicit boolean; absent / non-boolean → true.
            self.required = (try? c.decodeIfPresent(Bool.self, forKey: .required)) ?? true
        }
    }

    struct Option: Identifiable, Decodable {
        let id: UUID
        /// Button text.
        let label: String
        /// Text sent back to Claude when this option is picked. Defaults to
        /// `label` when absent, so the model can have a richer answer sent than
        /// the short button shows.
        let value: String?
        /// Optional named free-text inputs. When non-empty the option renders as
        /// a mini-form; when empty (all dropped / `[]` / non-array) the option
        /// degrades to a plain instant-send button — never an empty form.
        let fields: [Field]

        /// What gets sent to Claude on tap.
        var answer: String { value ?? label }

        /// Whether this option carries surviving fields (renders as a form).
        var hasFields: Bool { !fields.isEmpty }

        private enum CodingKeys: String, CodingKey { case label, value, fields }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id = UUID()
            self.label = try c.decode(String.self, forKey: .label)
            self.value = try c.decodeIfPresent(String.self, forKey: .value)
            // `fields` must be an array; drop entries that aren't objects with a
            // string `name`. A non-array, missing, or all-dropped `fields`
            // collapses to [] → the option degrades to a plain instant-send row.
            if var arr = try? c.nestedUnkeyedContainer(forKey: .fields) {
                var parsed: [Field] = []
                while !arr.isAtEnd {
                    if let field = try? arr.decode(Field.self) {
                        parsed.append(field)
                    } else {
                        // Skip a malformed entry without aborting the array.
                        _ = try? arr.decode(AnyDecodableSkip.self)
                    }
                }
                self.fields = parsed
            } else {
                self.fields = []
            }
        }
    }

    private enum CodingKeys: String, CodingKey { case question, options }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = UUID()
        self.question = try c.decode(String.self, forKey: .question)
        // Lossy per-option decode: keep options whose `label` is a string, skip
        // the rest (parity with the web filter). `options` must be an array.
        var arr = try c.nestedUnkeyedContainer(forKey: .options)
        var parsed: [Option] = []
        while !arr.isAtEnd {
            if let option = try? arr.decode(Option.self) {
                parsed.append(option)
            } else {
                _ = try? arr.decode(AnyDecodableSkip.self)
            }
        }
        self.options = parsed
    }

    /// Build the message sent back to Claude when ONE option is answered, with
    /// any field values the user filled in. Single source of truth for the answer
    /// string on Swift; the byte-identical twin of the web `buildQuestionAnswer`
    /// in `packages/k8s/src/actionBlocks.ts`. See docs/parity/chat-input-fields.md § 3.
    ///
    /// Format:
    ///   > {question}
    ///   {option.value ?? option.label}
    ///   {field.name}: {value}   (one per field WITH a value, in field order)
    ///
    /// A field whose value is blank/whitespace-only is omitted. The fieldless
    /// path (`values` empty / all blank) is byte-identical to today's
    /// `> question\n answer`, preserving backward compatibility.
    static func buildQuestionAnswer(
        question: String,
        option: Option,
        values: [String: String]
    ) -> String {
        var lines = ["> \(question)", option.answer]
        for field in option.fields {
            let raw = values[field.name] ?? ""
            if raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
            lines.append("\(field.name): \(raw)")
        }
        return lines.joined(separator: "\n")
    }

    /// Build the single message sent back to Claude when several question groups
    /// are answered together. Each answered group becomes a `>` blockquote with
    /// the full question prose followed by the chosen option's answer, in the
    /// order the groups appeared, blank-line separated. Groups with no selection
    /// are skipped (Submit gates on completeness, but the builder stays safe).
    ///
    /// Batch mode is fieldless-only (fields inside batch are out of scope), so
    /// each group reuses `buildQuestionAnswer` with no values — keeping it
    /// byte-identical to the historical `> question\n answer` output.
    static func combinedAnswer(questions: [ClarifyingQuestion], selections: [UUID: UUID]) -> String {
        questions.compactMap { question -> String? in
            guard let optionID = selections[question.id],
                  let option = question.options.first(where: { $0.id == optionID })
            else { return nil }
            return buildQuestionAnswer(question: question.question, option: option, values: [:])
        }
        .joined(separator: "\n\n")
    }
}

/// Decodes-and-discards any single JSON value so a lossy unkeyed container can
/// advance past a malformed entry without aborting the whole array.
private struct AnyDecodableSkip: Decodable {
    init(from decoder: Decoder) throws {
        // Try the common shapes, then fall back to a single value, so we always
        // consume exactly one element of the array.
        if let c = try? decoder.container(keyedBy: SkipKey.self) {
            for key in c.allKeys { _ = try? c.decode(AnyDecodableSkip.self, forKey: key) }
            return
        }
        if var c = try? decoder.unkeyedContainer() {
            while !c.isAtEnd { _ = try? c.decode(AnyDecodableSkip.self) }
            return
        }
        let s = try decoder.singleValueContainer()
        if s.decodeNil() { return }
        if (try? s.decode(Bool.self)) != nil { return }
        if (try? s.decode(Double.self)) != nil { return }
        _ = try? s.decode(String.self)
    }
    private struct SkipKey: CodingKey {
        var stringValue: String; var intValue: Int?
        init?(stringValue: String) { self.stringValue = stringValue; self.intValue = nil }
        init?(intValue: Int) { self.intValue = intValue; self.stringValue = String(intValue) }
    }
}
