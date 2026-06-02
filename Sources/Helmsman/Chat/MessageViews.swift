import SwiftUI
import AppKit
import MarkdownUI

struct MessageBubble: View {
    let message: ChatMessage
    var onRetry: ((String) -> Void)? = nil
    var onSuggestedAction: (SuggestedAction) -> Void = { _ in }
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
                if !parsed.questions.isEmpty {
                    ForEach(parsed.questions) { question in
                        ClarifyingQuestionView(question: question, onAnswer: onAnswerQuestion)
                            .padding(.top, 4)
                    }
                }
                if !parsed.actions.isEmpty {
                    SuggestedActionList(actions: parsed.actions, onTap: onSuggestedAction)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(actions) { action in
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
    }
}

/// A clarifying question Claude raised, with its options as tappable buttons.
/// Tapping one sends that option's answer back as the user's next message.
struct ClarifyingQuestionView: View {
    let question: ClarifyingQuestion
    let onAnswer: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(question.question)
                .font(Theme.Font.body(12, weight: .medium))
                .foregroundStyle(Theme.Foreground.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(question.options) { option in
                Button {
                    onAnswer(option.answer)
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "circle")
                            .font(.system(size: 10, weight: .semibold))
                        Text(option.label)
                            .font(Theme.Font.body(12, weight: .semibold))
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 4)
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
                .help("Answer — \(option.label)")
            }
        }
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
