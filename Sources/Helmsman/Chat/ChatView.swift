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

    /// Suggested-prompt chips, refreshed on appear and between chat turns rather
    /// than recomputed every render — keeps the cluster-watch churn out of body.
    @State private var cachedPrompts: [SuggestedPrompt] = []
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
                            }, onSuggestedAction: onSuggestedAction)
                            .id(msg.id)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                        }
                    }
                    .animation(.easeOut(duration: 0.2), value: viewModel.messages.count)
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

            if !viewModel.isStreaming {
                SuggestedPromptsRow(prompts: cachedPrompts, onTap: onSuggestedPrompt)
            }
            if viewModel.isStreaming {
                ThinkingPane(thinking: viewModel.liveThinking, startedAt: viewModel.turnStartedAt)
            }
            ChatComposer(
                viewModel: viewModel,
                onSlashCommand: onSlashCommand,
                mentionCandidates: mentionCandidates,
                inputFocused: $inputFocused
            )
        }
        .background(Theme.Surface.elevated)
        .animation(.easeInOut(duration: 0.25), value: viewModel.isStreaming)
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
            Spacer()
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
}
