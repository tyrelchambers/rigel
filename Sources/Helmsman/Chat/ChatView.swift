import SwiftUI
import AppKit
import MarkdownUI

struct ChatView: View {
    @Bindable var viewModel: ChatViewModel
    var onSlashCommand: (SlashCommand) -> Void = { _ in }
    /// Lazily-evaluated so the (O(cluster)) builders run only when prompts are
    /// actually refreshed — never on every parent render. See `cachedPrompts`.
    var suggestedPrompts: () -> [SuggestedPrompt] = { [] }
    var onSuggestedPrompt: (SuggestedPrompt) -> Void = { _ in }
    /// Lazily-evaluated; the candidate pool is built once per mention session
    /// (when `@` is first typed), not on every render. See `mentionPool`.
    var mentionCandidates: () -> [MentionCandidate] = { [] }
    var onNewChat: () -> Void = {}
    var onOpenHistory: () -> Void = {}
    /// Fired when the user taps an action button Claude suggested in a message.
    var onSuggestedAction: (SuggestedAction) -> Void = { _ in }

    @State private var mentionQuery: String? = nil
    @State private var mentionSelectedIndex = 0
    /// Suggested-prompt chips, refreshed on appear and between chat turns rather
    /// than recomputed every render — keeps the cluster-watch churn out of body.
    @State private var cachedPrompts: [SuggestedPrompt] = []
    /// Mention candidate pool, rebuilt when a mention session begins.
    @State private var mentionPool: [MentionCandidate] = []
    /// Active when the composer holds a leading `/token` — drives the command popover.
    @State private var commandQuery: String? = nil
    @State private var commandSelectedIndex = 0
    /// Per-message context summaries attached to the next send. Cleared after send.
    @State private var attachedMentions: [MentionCandidate] = []
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(viewModel.messages) { msg in
                            MessageBubble(message: msg, onRetry: { text in
                                viewModel.inputText = text
                                inputFocused = true
                            }, onSuggestedAction: onSuggestedAction).id(msg.id)
                        }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 14)
                }
                .background(Theme.Surface.elevated)
                .onChange(of: viewModel.messages.count) { _, _ in
                    if let last = viewModel.messages.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
                // Cursor is no longer auto-grabbed on launch — focus the chat
                // deliberately via ⌘L or by clicking the input.
            }

            SuggestedPromptsRow(prompts: cachedPrompts, onTap: onSuggestedPrompt)
            inputBar
        }
        .background(Theme.Surface.elevated)
        // Refresh on a slow timer (not on every cluster watch event — that's
        // what made the whole window churn) so dynamic chips like the grouped
        // warnings appear shortly after events stream in. Skips the assignment
        // when the chips are unchanged to avoid needless redraws.
        .task {
            while !Task.isCancelled {
                let fresh = suggestedPrompts()
                if fresh != cachedPrompts { cachedPrompts = fresh }
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
        // Also refresh immediately between turns (a new message arrived).
        .onChange(of: viewModel.messages.count) { _, _ in cachedPrompts = suggestedPrompts() }
        .onDisappear { viewModel.stop() }
        .background {
            Button("Focus chat input") { inputFocused = true }
                .keyboardShortcut("l", modifiers: .command)
                .hidden()
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkles")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Accent.primary)
            Text("Claude")
                .font(Theme.Font.body(13, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            if viewModel.isStreaming {
                HStack(spacing: 4) {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(Theme.Accent.primary)
                    Text("thinking")
                        .font(Theme.Font.body(10))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
            }
            Spacer()
            modelMenu
            if viewModel.isStreaming {
                headerButton(system: "stop.fill", tint: Theme.Status.failed, help: "Stop reply (SIGINT)") {
                    viewModel.interrupt()
                }
            }
            headerButton(system: "doc.on.doc", tint: Theme.Foreground.secondary, help: "Copy conversation") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(viewModel.transcript(), forType: .string)
            }
            .disabled(viewModel.messages.isEmpty)
            headerButton(system: "eraser", tint: Theme.Foreground.secondary, help: "Clear visible messages") {
                viewModel.clear()
            }
            headerButton(system: "square.and.pencil", tint: Theme.Accent.primary, help: "New chat") {
                onNewChat()
            }
            headerButton(system: "clock.arrow.circlepath", tint: Theme.Foreground.secondary, help: "Chat history") {
                onOpenHistory()
            }
            if let sid = viewModel.sessionId {
                Text(sid.prefix(8))
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    /// Model + effort picker. Reads/writes `viewModel.modelConfig`; changing
    /// either relaunches the session under the new model (see setModelConfig).
    private var modelMenu: some View {
        Menu {
            Picker("Model", selection: modelBinding) {
                ForEach(ClaudeModel.allCases) { m in
                    Text(m.displayName).tag(m)
                }
            }
            Picker("Effort", selection: effortBinding) {
                ForEach(ClaudeEffort.allCases) { e in
                    Text(e.displayName).tag(e)
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "cpu")
                    .font(.system(size: 10, weight: .medium))
                Text(viewModel.modelConfig.shortLabel)
                    .font(Theme.Font.body(10, weight: .medium))
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
            }
            .foregroundStyle(Theme.Foreground.secondary)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Theme.Surface.sunken)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Model & reasoning effort — changing it restarts the session, keeping this conversation")
    }

    private var modelBinding: Binding<ClaudeModel> {
        Binding(
            get: { viewModel.modelConfig.model },
            set: { viewModel.setModelConfig(.init(model: $0, effort: viewModel.modelConfig.effort)) }
        )
    }

    private var effortBinding: Binding<ClaudeEffort> {
        Binding(
            get: { viewModel.modelConfig.effort },
            set: { viewModel.setModelConfig(.init(model: viewModel.modelConfig.model, effort: $0)) }
        )
    }

    private func headerButton(system: String, tint: Color, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: 22, height: 22)
                .background(Theme.Surface.sunken)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
        .help(help)
    }

    private var inputBar: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
            if let q = mentionQuery {
                MentionPopover(
                    candidates: MentionIndex.filter(mentionPool, query: q),
                    selectedIndex: mentionSelectedIndex,
                    onPick: pickMention
                )
                .padding(.horizontal, 12).padding(.top, 6)
            }
            if let q = commandQuery {
                CommandPopover(
                    commands: ChatCommandRegistry.filter(q),
                    selectedIndex: commandSelectedIndex,
                    onPick: pickCommand
                )
                .padding(.horizontal, 12).padding(.top, 6)
            }
            if !attachedMentions.isEmpty {
                attachedMentionsRow
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Ask Claude…  (/ for commands, @ to mention a resource)", text: $viewModel.inputText, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(Theme.Font.body(13))
                    .foregroundStyle(Theme.Foreground.primary)
                    .lineLimit(1...6)
                    .focused($inputFocused)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(Theme.Surface.sunken)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md)
                            .strokeBorder(Theme.Border.strong, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    .onSubmit { sendInput() }
                    .onChange(of: viewModel.inputText) { _, newValue in
                        updateMentionQuery(from: newValue)
                        updateCommandQuery(from: newValue)
                    }
                    .onKeyPress(.downArrow) {
                        if commandQuery != nil {
                            let count = ChatCommandRegistry.filter(commandQuery ?? "").count
                            commandSelectedIndex = min(commandSelectedIndex + 1, max(0, count - 1))
                            return .handled
                        }
                        guard mentionQuery != nil else { return .ignored }
                        let count = MentionIndex.filter(mentionPool, query: mentionQuery ?? "").count
                        mentionSelectedIndex = min(mentionSelectedIndex + 1, max(0, count - 1))
                        return .handled
                    }
                    .onKeyPress(.upArrow) {
                        if commandQuery != nil {
                            commandSelectedIndex = max(0, commandSelectedIndex - 1)
                            return .handled
                        }
                        if mentionQuery != nil {
                            mentionSelectedIndex = max(0, mentionSelectedIndex - 1)
                            return .handled
                        }
                        // No active popover → ↑ on empty input recalls last message.
                        if viewModel.inputText.isEmpty, let last = viewModel.lastUserMessage {
                            viewModel.inputText = last
                            return .handled
                        }
                        return .ignored
                    }
                    .onKeyPress(.tab) {
                        if commandQuery != nil { commitSelectedCommand(); return .handled }
                        guard mentionQuery != nil else { return .ignored }
                        commitSelectedMention()
                        return .handled
                    }
                    .onKeyPress(.return) {
                        // With the command popover open, Enter picks the highlighted
                        // command rather than sending a half-typed "/lo".
                        if commandQuery != nil { commitSelectedCommand(); return .handled }
                        return .ignored
                    }
                    .onKeyPress(.escape) {
                        if commandQuery != nil { commandQuery = nil; return .handled }
                        if mentionQuery != nil { mentionQuery = nil; return .handled }
                        return .ignored
                    }

                Button(action: sendInput) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Theme.Foreground.inverse)
                        .frame(width: 34, height: 34)
                        .background(canSend ? Theme.Accent.primary : Theme.Border.strong)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!canSend)
            }
            .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 6)
            .background(Theme.Surface.elevated)

            commandsChipRow
        }
    }

    private var attachedMentionsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 5) {
                ForEach(attachedMentions) { c in
                    HStack(spacing: 4) {
                        Image(systemName: c.iconName).font(.system(size: 9))
                        Text(c.name)
                            .font(Theme.Font.mono(10, weight: .medium))
                        Button {
                            attachedMentions.removeAll { $0.id == c.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 9))
                                .foregroundStyle(Theme.Foreground.tertiary)
                        }
                        .buttonStyle(.plain)
                    }
                    .foregroundStyle(Theme.Accent.primary)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Theme.Accent.primaryDim)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
            }
            .padding(.horizontal, 12).padding(.top, 6)
        }
    }

    private var canSend: Bool {
        !viewModel.inputText.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func sendInput() {
        let text = viewModel.inputText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        if let cmd = SlashCommand.parse(text) {
            viewModel.inputText = ""
            attachedMentions.removeAll()
            onSlashCommand(cmd)
            return
        }
        let final: String
        if attachedMentions.isEmpty {
            final = text
        } else {
            let context = attachedMentions.map { "- \($0.contextSummary)" }.joined(separator: "\n")
            final = "\(text)\n\n_Attached resources:_\n\(context)"
        }
        viewModel.send(final)
        viewModel.inputText = ""
        attachedMentions.removeAll()
        mentionQuery = nil
    }

    /// Scan inputText backwards from the end. If we're inside an `@token` (i.e.
    /// the cursor is after an `@` with only non-whitespace between), set
    /// `mentionQuery`. Otherwise clear it.
    private func updateMentionQuery(from text: String) {
        // Look at the trailing segment of the input.
        guard let atRange = text.range(of: "@", options: .backwards) else {
            mentionQuery = nil
            return
        }
        let tail = text[atRange.upperBound...]
        if tail.contains(" ") || tail.contains("\n") {
            mentionQuery = nil
            return
        }
        // Allow letters, digits, dashes — close popover on anything else (e.g. punctuation).
        if !tail.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." }) {
            mentionQuery = nil
            return
        }
        // Build the candidate pool once at the start of a mention session; it
        // stays stable while the user keeps typing the same @token.
        if mentionQuery == nil { mentionPool = mentionCandidates() }
        mentionQuery = String(tail)
        mentionSelectedIndex = 0
    }

    private func commitSelectedMention() {
        guard let q = mentionQuery else { return }
        let filtered = MentionIndex.filter(mentionPool, query: q)
        guard filtered.indices.contains(mentionSelectedIndex) else { return }
        pickMention(filtered[mentionSelectedIndex])
    }

    private func pickMention(_ c: MentionCandidate) {
        // Replace the trailing @query token in input with the resource name.
        if let atRange = viewModel.inputText.range(of: "@", options: .backwards) {
            viewModel.inputText.replaceSubrange(atRange.lowerBound..<viewModel.inputText.endIndex, with: c.name + " ")
        }
        if !attachedMentions.contains(where: { $0.id == c.id }) {
            attachedMentions.append(c)
        }
        mentionQuery = nil
    }

    // MARK: - Commands

    /// A "commands" chip under the input — lists every command, so they're
    /// discoverable without knowing to type `/`.
    private var commandsChipRow: some View {
        HStack(spacing: 6) {
            Menu {
                ForEach(ChatCommandRegistry.all) { spec in
                    Button {
                        viewModel.inputText = spec.insertion
                        commandQuery = spec.argHint == nil ? nil : ""
                        commandSelectedIndex = 0
                        inputFocused = true
                    } label: {
                        Text("\(spec.display) — \(spec.description)")
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                    Text("commands")
                        .font(Theme.Font.body(11, weight: .medium))
                }
                .foregroundStyle(Theme.Foreground.secondary)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Theme.Surface.field)
                .clipShape(Capsule())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("Browse chat commands")
            Spacer()
        }
        .padding(.horizontal, 12).padding(.bottom, 10)
        .background(Theme.Surface.elevated)
    }

    /// Active when the whole input is a leading slash token (`/`, `/lo`, …) with
    /// no space yet — i.e. the command name is still being typed. Clears once a
    /// space (the argument) or any non-command text follows.
    private func updateCommandQuery(from text: String) {
        guard text.hasPrefix("/") else { commandQuery = nil; return }
        let token = text.dropFirst()
        if token.contains(" ") || token.contains("\n") {
            commandQuery = nil
            return
        }
        guard token.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "?" }) else {
            commandQuery = nil
            return
        }
        commandQuery = String(token)
        commandSelectedIndex = 0
    }

    private func commitSelectedCommand() {
        guard let q = commandQuery else { return }
        let filtered = ChatCommandRegistry.filter(q)
        guard filtered.indices.contains(commandSelectedIndex) else { return }
        pickCommand(filtered[commandSelectedIndex])
    }

    private func pickCommand(_ spec: ChatCommandSpec) {
        viewModel.inputText = spec.insertion
        // No-arg commands are ready to fire; keep the popover open for ones that
        // still need an argument so the user knows to type it.
        commandQuery = nil
        inputFocused = true
    }
}
