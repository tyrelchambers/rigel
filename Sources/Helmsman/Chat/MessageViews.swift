import SwiftUI
import AppKit
import MarkdownUI

struct MessageBubble: View {
    let message: ChatMessage
    var onRetry: ((String) -> Void)? = nil
    var onSuggestedAction: (SuggestedAction) -> Void = { _ in }
    /// Fired with the selected actions when the user runs a batch ("Run
    /// selected") from a message carrying multiple action buttons.
    var onRunActions: ([SuggestedAction]) -> Void = { _ in }
    /// Fired with the chosen answer text when the user taps a clarifying-question
    /// option — sent back to Claude as the next message.
    var onAnswerQuestion: (String) -> Void = { _ in }
    @State private var thoughtExpanded = false

    private typealias Parsed = (display: String, actions: [SuggestedAction], questions: [ClarifyingQuestion])

    /// For assistant messages, split prose from any ```action / ```question
    /// button blocks. User/system messages render verbatim. Computed once per
    /// body evaluation and threaded through — `SuggestedAction.parse` scans the
    /// whole message, so re-running it several times per render adds up.
    private var parsed: Parsed {
        guard message.role == .assistant else { return (message.text, [], []) }
        return SuggestedAction.parse(from: message.text)
    }

    var body: some View {
        if let tool = message.tool {
            ToolCard(tool: tool)
        } else {
            let parsed = self.parsed
            textBubble(parsed)
                .contextMenu {
                    Button("Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(parsed.display, forType: .string)
                    }
                    if message.role == .user, let onRetry {
                        Button("Edit & resend") { onRetry(message.text) }
                    }
                }
        }
    }

    private func textBubble(_ parsed: Parsed) -> some View {
        HStack(alignment: .top, spacing: 8) {
            roleIcon
            VStack(alignment: .leading, spacing: 4) {
                Text(roleLabel)
                    .font(Theme.Font.body(10, weight: .semibold))
                    .foregroundStyle(roleColor)
                    .textCase(.uppercase)
                    .tracking(0.5)
                thoughtTrail
                content(parsed)
                if parsed.questions.count == 1, let question = parsed.questions.first {
                    ClarifyingQuestionView(question: question, onAnswer: onAnswerQuestion)
                        .padding(.top, 4)
                } else if !parsed.questions.isEmpty {
                    // 2+ groups: collect one answer per group, send together — a
                    // tap on any single option would otherwise end the turn.
                    ClarifyingQuestionBatchView(questions: parsed.questions, onSubmit: onAnswerQuestion)
                        .padding(.top, 4)
                }
                if !parsed.actions.isEmpty {
                    SuggestedActionList(actions: parsed.actions, onTap: onSuggestedAction, onRunBatch: onRunActions)
                        .padding(.top, 4)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .strokeBorder(border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
    }

    @ViewBuilder private func content(_ parsed: Parsed) -> some View {
        switch message.role {
        case .assistant:
            if !parsed.display.isEmpty {
                Markdown(parsed.display)
                    .markdownTheme(.claudeK8s)
                    .textSelection(.enabled)
            }
        case .user, .system:
            Text(message.text)
                .font(Theme.Font.body(13))
                .foregroundStyle(Theme.Foreground.primary)
                .textSelection(.enabled)
        }
    }

    /// Collapsed "✻ Thought for Ns" disclosure for the reasoning Claude streamed
    /// on this turn. Only assistant messages that captured thinking show it.
    @ViewBuilder private var thoughtTrail: some View {
        if let thinking = message.thinking, !thinking.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Button { withAnimation(.easeInOut(duration: 0.2)) { thoughtExpanded.toggle() } } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "sparkle").font(.system(size: 9))
                        Text(thoughtLabel)
                            .font(Theme.Font.body(10, weight: .medium))
                        Image(systemName: thoughtExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 8, weight: .semibold))
                    }
                    .foregroundStyle(Theme.Foreground.tertiary)
                }
                .buttonStyle(.plain)
                if thoughtExpanded {
                    Text(thinking)
                        .font(Theme.Font.body(11))
                        .italic()
                        .foregroundStyle(Theme.Foreground.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 2)
                }
            }
        }
    }

    private var thoughtLabel: String {
        if let s = message.thinkingSeconds, s > 0 { return "Thought for \(s)s" }
        return "Thought process"
    }

    @ViewBuilder private var roleIcon: some View {
        ZStack {
            Circle().fill(roleColor.opacity(0.15))
            Image(systemName: roleIconName)
                .font(.system(size: 11))
                .foregroundStyle(roleColor)
        }
        .frame(width: 24, height: 24)
    }

    private var roleIconName: String {
        switch message.role {
        case .user:      return "person.fill"
        case .assistant: return "sparkles"
        case .system:    return "gear"
        }
    }

    private var roleLabel: String {
        switch message.role {
        case .user:      return "You"
        case .assistant: return "Helmsman"
        case .system:    return "System"
        }
    }

    private var roleColor: Color {
        switch message.role {
        case .user:      return Theme.Pod.palette[0]
        case .assistant: return Theme.Accent.primary
        case .system:    return Theme.Foreground.tertiary
        }
    }

    private var background: Color {
        switch message.role {
        case .user:      return Theme.Surface.sunken
        case .assistant: return Theme.Accent.primary.opacity(0.06)
        case .system:    return Theme.Surface.sunken
        }
    }

    private var border: Color {
        switch message.role {
        case .user:      return Theme.Border.subtle
        case .assistant: return Theme.Accent.primary.opacity(0.2)
        case .system:    return Theme.Border.subtle
        }
    }
}

extension MessageBubble: Equatable {
    /// Re-render a bubble only when its message value actually changes. During
    /// streaming the array is reassigned every token, which would otherwise
    /// re-run `body` (re-parsing markdown + action blocks) for the WHOLE
    /// transcript; with this, only the growing last bubble re-renders. The
    /// callbacks are intentionally excluded — they forward to stable handlers,
    /// so comparing `message` alone is correct. Used via `.equatable()` in ChatView.
    static func == (lhs: MessageBubble, rhs: MessageBubble) -> Bool {
        lhs.message == rhs.message
    }
}

/// Stack of accent buttons for the actions Claude suggested in a message.
/// Each runs through the app's confirm → kubectl path on tap.
struct SuggestedActionList: View {
    let actions: [SuggestedAction]
    let onTap: (SuggestedAction) -> Void
    /// Run several actions back-to-back. Only surfaced when there are 2+.
    var onRunBatch: ([SuggestedAction]) -> Void = { _ in }

    /// IDs the user has unchecked. Default (empty) = everything selected, so a
    /// freshly-rendered multi-action message is ready to "Run selected (all)".
    @State private var deselected: Set<UUID> = []

    private var isMulti: Bool { actions.count > 1 }
    private func isSelected(_ a: SuggestedAction) -> Bool { !deselected.contains(a.id) }
    private var selectedActions: [SuggestedAction] { actions.filter(isSelected) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(actions) { action in
                row(action)
            }
            if isMulti {
                batchBar
            }
        }
    }

    private func row(_ action: SuggestedAction) -> some View {
        HStack(spacing: 6) {
            // Batch-selection checkbox (only meaningful with 2+ actions).
            if isMulti {
                Button {
                    if deselected.contains(action.id) { deselected.remove(action.id) }
                    else { deselected.insert(action.id) }
                } label: {
                    Image(systemName: isSelected(action) ? "checkmark.square.fill" : "square")
                        .font(.system(size: 13))
                        .foregroundStyle(isSelected(action) ? Theme.Accent.primary : Theme.Foreground.tertiary)
                }
                .buttonStyle(.plain)
                .help(isSelected(action) ? "Deselect from batch" : "Select for batch")
            }

            // The action itself — tapping runs just this one (today's behavior).
            Button {
                onTap(action)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: action.systemImage)
                        .font(.system(size: 11, weight: .semibold))
                    Text(action.label)
                        .font(Theme.Font.body(12, weight: .semibold))
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 4)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 9, weight: .semibold))
                        .opacity(0.6)
                }
                .foregroundStyle(Theme.Accent.primary)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.Accent.primaryDim)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Accent.primary.opacity(0.4), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .help("Review and run — \(action.label)")
        }
    }

    private var batchBar: some View {
        HStack(spacing: 8) {
            Button { deselected = Set(actions.map(\.id)) } label: {
                Text("None").font(Theme.Font.body(11, weight: .medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.Foreground.tertiary)
            .disabled(selectedActions.isEmpty)

            Button { deselected.removeAll() } label: {
                Text("All").font(Theme.Font.body(11, weight: .medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.Foreground.tertiary)
            .disabled(deselected.isEmpty)

            Spacer()

            Button {
                onRunBatch(selectedActions)
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "play.fill").font(.system(size: 9, weight: .semibold))
                    Text("Run selected (\(selectedActions.count))")
                        .font(Theme.Font.body(12, weight: .semibold))
                }
                .foregroundStyle(Theme.Foreground.inverse)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(selectedActions.isEmpty ? Theme.Foreground.tertiary : Theme.Accent.primary)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                .opacity(selectedActions.isEmpty ? 0.5 : 1)
            }
            .buttonStyle(.plain)
            .disabled(selectedActions.isEmpty)
            .help("Run the selected actions in order, stopping at the first failure")
        }
        .padding(.top, 2)
    }
}

/// One tappable option in a clarifying question. Shows a hollow circle when
/// unselected and a filled one when selected, so the same row serves both the
/// instant-send single-question view and the radio-style batch view.
///
/// `glyph` swaps the leading symbol: the radio circle for choice options, a
/// `pencil` for the lone always-open input case (§ 4.3). Both render at the same
/// 10pt semibold size to keep the row metrics identical.
private struct QuestionOptionRow: View {
    enum Glyph { case radio, pencil }

    let label: String
    let selected: Bool
    var glyph: Glyph = .radio
    let action: () -> Void

    private var glyphName: String {
        switch glyph {
        case .pencil: return "pencil"
        case .radio:  return selected ? "largecircle.fill.circle" : "circle"
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: glyphName)
                    .font(.system(size: 10, weight: .semibold))
                Text(label)
                    .font(Theme.Font.body(12, weight: .semibold))
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 4)
            }
            .foregroundStyle(Theme.Accent.primary)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Theme.Accent.primary.opacity(0.28) : Theme.Accent.primaryDim)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(Theme.Accent.primary.opacity(selected ? 0.9 : 0.4), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
        .help("Answer — \(label)")
    }
}

/// The inline mini-form shown under a picked input-bearing option (§ 4.2) or
/// always-open beneath the lone-input pencil row (§ 4.3). Renders one labelled
/// text field per `Field` in array order plus a required-gated `↵` submit.
/// Enter in any field submits when enabled. Reports values keyed by `field.name`.
private struct QuestionFieldsForm: View {
    let fields: [ClarifyingQuestion.Field]
    let locked: Bool
    let onSubmit: ([String: String]) -> Void

    @State private var values: [String: String] = [:]

    /// Submit gates on every REQUIRED field being non-empty (after trimming);
    /// optional fields may be blank.
    private var canSubmit: Bool {
        guard !locked else { return false }
        for field in fields where field.required {
            let v = values[field.name] ?? ""
            if v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        }
        return true
    }

    private func submit() {
        guard canSubmit else { return }
        onSubmit(values)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(fields) { field in
                VStack(alignment: .leading, spacing: 3) {
                    Text(field.displayLabel)
                        .font(Theme.Font.body(11, weight: .medium))
                        .foregroundStyle(Theme.Foreground.secondary)
                    TextField(
                        field.placeholder ?? "",
                        text: Binding(
                            get: { values[field.name] ?? "" },
                            set: { values[field.name] = $0 }
                        )
                    )
                    .textFieldStyle(.plain)
                    .font(Theme.Font.body(12))
                    .foregroundStyle(Theme.Foreground.primary)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .background(Theme.Accent.primaryDim)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.sm)
                            .strokeBorder(Theme.Accent.primary.opacity(0.4), lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    .onSubmit(submit)   // Enter submits when enabled; no-op otherwise.
                    .disabled(locked)
                }
            }

            HStack {
                Spacer()
                Button(action: submit) {
                    Image(systemName: "return")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.Foreground.inverse)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(canSubmit ? Theme.Accent.primary : Theme.Foreground.tertiary)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                        .opacity(canSubmit ? 1 : 0.5)
                }
                .buttonStyle(.plain)
                .disabled(!canSubmit)
                .help(canSubmit ? "Send answer" : "Fill every required field to submit")
            }
        }
        .padding(.leading, 16)   // indent the form under its option row
    }
}

/// A single clarifying question Claude raised. Three behaviors fall out of one
/// schema (docs/parity/chat-input-fields.md § 4):
///   (a) fieldless option → instant-send button (tap sends immediately);
///   (b) input-bearing option in a 2+ option block → pick-to-expand mini-form,
///       single-open radio semantics;
///   (c) a block with EXACTLY ONE input-bearing option → always-open form with a
///       pencil glyph (no radio, no tap).
/// After a successful send the whole block locks to prevent a double-send.
struct ClarifyingQuestionView: View {
    let question: ClarifyingQuestion
    let onAnswer: (String) -> Void

    /// The option whose form is currently expanded (behavior b). Nil = none open.
    @State private var expandedOptionID: UUID? = nil
    @State private var submitted = false

    /// True when the block is a single input-bearing option (behavior c).
    private var loneInput: ClarifyingQuestion.Option? {
        guard question.options.count == 1, let only = question.options.first, only.hasFields
        else { return nil }
        return only
    }

    private func send(option: ClarifyingQuestion.Option, values: [String: String]) {
        guard !submitted else { return }
        onAnswer(ClarifyingQuestion.buildQuestionAnswer(
            question: question.question, option: option, values: values))
        submitted = true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(question.question)
                .font(Theme.Font.body(12, weight: .medium))
                .foregroundStyle(Theme.Foreground.primary)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let only = loneInput {
                // (c) Always-open lone input: pencil glyph, no tap, form shown.
                QuestionOptionRow(label: only.label, selected: true, glyph: .pencil) {}
                    .allowsHitTesting(false)
                QuestionFieldsForm(fields: only.fields, locked: submitted) { values in
                    send(option: only, values: values)
                }
            } else {
                // (a)/(b) Choice rows; input-bearing ones expand on pick.
                ForEach(question.options) { option in
                    QuestionOptionRow(
                        label: option.label,
                        selected: expandedOptionID == option.id
                    ) {
                        if option.hasFields {
                            // (b) Single-open radio: toggle/replace the open form.
                            expandedOptionID = (expandedOptionID == option.id) ? nil : option.id
                        } else {
                            // (a) Fieldless → instant-send, byte-identical to today.
                            send(option: option, values: [:])
                        }
                    }
                    if option.hasFields, expandedOptionID == option.id {
                        QuestionFieldsForm(fields: option.fields, locked: submitted) { values in
                            send(option: option, values: values)
                        }
                    }
                }
            }
        }
        .opacity(submitted ? 0.55 : 1)
        .disabled(submitted)
    }
}

/// Two or more question groups from one assistant message. Each group is a
/// single-choice radio list; the user picks one option per group, then submits
/// all answers in one message. Submit stays disabled until every group has a
/// selection, and the whole block locks once submitted to prevent a double-send.
struct ClarifyingQuestionBatchView: View {
    let questions: [ClarifyingQuestion]
    let onSubmit: (String) -> Void

    @State private var selections: [UUID: UUID] = [:]
    @State private var submitted = false

    private var allAnswered: Bool { selections.count == questions.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(questions) { question in
                VStack(alignment: .leading, spacing: 6) {
                    Text(question.question)
                        .font(Theme.Font.body(12, weight: .medium))
                        .foregroundStyle(Theme.Foreground.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ForEach(question.options) { option in
                        QuestionOptionRow(
                            label: option.label,
                            selected: selections[question.id] == option.id
                        ) {
                            selections[question.id] = option.id
                        }
                    }
                }
            }

            HStack {
                Spacer()
                Button {
                    onSubmit(ClarifyingQuestion.combinedAnswer(questions: questions, selections: selections))
                    submitted = true
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "paperplane.fill").font(.system(size: 9, weight: .semibold))
                        Text("Submit answers")
                            .font(Theme.Font.body(12, weight: .semibold))
                    }
                    .foregroundStyle(Theme.Foreground.inverse)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(allAnswered ? Theme.Accent.primary : Theme.Foreground.tertiary)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    .opacity(allAnswered ? 1 : 0.5)
                }
                .buttonStyle(.plain)
                .disabled(!allAnswered || submitted)
                .help(allAnswered ? "Send all answers in one message" : "Answer every question to submit")
            }
        }
        .opacity(submitted ? 0.55 : 1)
        .disabled(submitted)
    }
}

struct ToolCard: View {
    let tool: ToolInvocation
    @State private var isExpanded = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 6).fill(Theme.Foreground.tertiary.opacity(0.15))
                Image(systemName: "wrench.adjustable.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text(tool.name)
                        .font(Theme.Font.mono(10, weight: .semibold))
                        .foregroundStyle(Theme.Foreground.secondary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Theme.Border.subtle)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    if let desc = tool.bashDescription, !desc.isEmpty {
                        Text(desc)
                            .font(Theme.Font.body(11))
                            .foregroundStyle(Theme.Foreground.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }

                if let cmd = tool.bashCommand {
                    Text(cmd)
                        .font(Theme.Font.mono(11))
                        .foregroundStyle(Theme.Foreground.primary)
                        .textSelection(.enabled)
                        .padding(.horizontal, 8).padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.Surface.sunken)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                } else {
                    Button {
                        isExpanded.toggle()
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                                .font(.system(size: 9))
                            Text(isExpanded ? "hide input" : "show input")
                                .font(Theme.Font.body(10))
                        }
                        .foregroundStyle(Theme.Foreground.tertiary)
                    }
                    .buttonStyle(.plain)
                    if isExpanded {
                        Text(tool.inputJSON)
                            .font(Theme.Font.mono(10))
                            .foregroundStyle(Theme.Foreground.secondary)
                            .textSelection(.enabled)
                            .padding(.horizontal, 8).padding(.vertical, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.Surface.sunken)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    }
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.Surface.sunken.opacity(0.5))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.md)
                    .strokeBorder(Theme.Border.subtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
    }
}
