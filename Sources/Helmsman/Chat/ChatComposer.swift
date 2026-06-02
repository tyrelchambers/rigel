import SwiftUI
import AppKit

/// The Claude-style composer: one rounded container holding attached-mention
/// chips, the multiline field, and an in-box control row (model picker · commands
/// · @hint on the left, send/stop on the right). Owns mention/command typeahead.
struct ChatComposer: View {
    @Bindable var viewModel: ChatViewModel
    var onSlashCommand: (SlashCommand) -> Void = { _ in }
    var mentionCandidates: () -> [MentionCandidate] = { [] }

    @FocusState.Binding var inputFocused: Bool

    @State private var mentionQuery: String? = nil
    @State private var mentionSelectedIndex = 0
    @State private var mentionPool: [MentionCandidate] = []
    @State private var commandQuery: String? = nil
    @State private var commandSelectedIndex = 0
    @State private var attachedMentions: [MentionCandidate] = []

    var body: some View {
        VStack(spacing: 0) {
            if let q = mentionQuery {
                MentionPopover(
                    candidates: MentionIndex.filter(mentionPool, query: q),
                    selectedIndex: mentionSelectedIndex,
                    onPick: pickMention
                )
                .padding(.horizontal, 12).padding(.bottom, 6)
            }
            if let q = commandQuery {
                CommandPopover(
                    commands: ChatCommandRegistry.filter(q),
                    selectedIndex: commandSelectedIndex,
                    onPick: pickCommand
                )
                .padding(.horizontal, 12).padding(.bottom, 6)
            }
            composerBox
                .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 10)
        }
        .background(Theme.Surface.elevated)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    /// The single rounded container — field on top, controls along the bottom.
    private var composerBox: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !attachedMentions.isEmpty { attachedMentionsRow }
            inputField
            controlRow
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Theme.Surface.sunken)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(inputFocused ? Theme.Accent.primary : Theme.Border.strong, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
    }

    private var inputField: some View {
        TextField("Ask Helmsman…  (/ for commands, @ to mention a resource)", text: $viewModel.inputText, axis: .vertical)
            .textFieldStyle(.plain)
            .font(Theme.Font.body(13))
            .foregroundStyle(Theme.Foreground.primary)
            .lineLimit(1...8)
            .focused($inputFocused)
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
            .onKeyPress(phases: .down) { press in
                guard press.key == .return else { return .ignored }
                // With a popover open, Enter commits the highlighted item rather
                // than sending a half-typed "/lo" or "@po" — mirrors Tab.
                if commandQuery != nil { commitSelectedCommand(); return .handled }
                if mentionQuery != nil { commitSelectedMention(); return .handled }
                // Shift+Enter falls through to the field's own newline insertion;
                // a plain Enter sends.
                if press.modifiers.contains(.shift) { return .ignored }
                sendInput()
                return .handled
            }
            .onKeyPress(.escape) {
                if commandQuery != nil { commandQuery = nil; return .handled }
                if mentionQuery != nil { mentionQuery = nil; return .handled }
                if viewModel.isStreaming { viewModel.interrupt(); return .handled }
                return .ignored
            }
    }

    private var controlRow: some View {
        HStack(spacing: 8) {
            ComposerModelMenu(viewModel: viewModel)
            commandsMenu
            Spacer(minLength: 4)
            sendOrStopButton
        }
    }

    @ViewBuilder private var sendOrStopButton: some View {
        if viewModel.isStreaming {
            Button(action: { viewModel.interrupt() }) {
                Image(systemName: "stop.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Theme.Foreground.inverse)
                    .frame(width: 30, height: 30)
                    .background(Theme.Status.failed)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }
            .buttonStyle(.plain)
            .help("Stop reply (esc)")
        } else {
            Button(action: sendInput) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Theme.Foreground.inverse)
                    .frame(width: 30, height: 30)
                    .background(canSend ? Theme.Accent.primary : Theme.Border.strong)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(!canSend)
            .help("Send (⌘↩)")
        }
    }

    /// Compact "/ commands" menu — same registry as before, now living in-box.
    private var commandsMenu: some View {
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
                Text("commands").font(Theme.Font.body(11, weight: .medium))
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
    }

    private var attachedMentionsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 5) {
                ForEach(attachedMentions) { c in
                    HStack(spacing: 4) {
                        Image(systemName: c.iconName).font(.system(size: 9))
                        Text(c.name).font(Theme.Font.mono(10, weight: .medium))
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

    private func updateMentionQuery(from text: String) {
        guard let atRange = text.range(of: "@", options: .backwards) else {
            mentionQuery = nil
            return
        }
        let tail = text[atRange.upperBound...]
        if tail.contains(" ") || tail.contains("\n") {
            mentionQuery = nil
            return
        }
        if !tail.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." }) {
            mentionQuery = nil
            return
        }
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
        if let atRange = viewModel.inputText.range(of: "@", options: .backwards) {
            viewModel.inputText.replaceSubrange(atRange.lowerBound..<viewModel.inputText.endIndex, with: c.name + " ")
        }
        if !attachedMentions.contains(where: { $0.id == c.id }) {
            attachedMentions.append(c)
        }
        mentionQuery = nil
    }

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
        commandQuery = nil
        inputFocused = true
    }
}

/// Model + effort picker, relocated from the header into the composer's control
/// row. Changing either restarts the session under the new model (keeps the convo).
struct ComposerModelMenu: View {
    @Bindable var viewModel: ChatViewModel

    var body: some View {
        Menu {
            Picker("Model", selection: modelBinding) {
                ForEach(ClaudeModel.allCases) { m in Text(m.displayName).tag(m) }
            }
            Picker("Effort", selection: effortBinding) {
                ForEach(ClaudeEffort.allCases) { e in Text(e.displayName).tag(e) }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "cpu").font(.system(size: 10, weight: .medium))
                Text(viewModel.modelConfig.shortLabel).font(Theme.Font.body(10, weight: .medium))
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
            }
            .foregroundStyle(Theme.Foreground.secondary)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Theme.Surface.field)
            .clipShape(Capsule())
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
}
