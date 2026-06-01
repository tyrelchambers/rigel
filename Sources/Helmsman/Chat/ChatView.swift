import SwiftUI
import AppKit

struct ChatView: View {
    @Bindable var viewModel: ChatViewModel
    var onSlashCommand: (SlashCommand) -> Void = { _ in }
    /// Lazily-evaluated so the (O(cluster)) builders run only when prompts are
    /// actually refreshed — never on every parent render. See `cachedPrompts`.
    var suggestedPrompts: () -> [SuggestedPrompt] = { [] }
    var onSuggestedPrompt: (SuggestedPrompt) -> Void = { _ in }
    /// Lazily-evaluated; the candidate pool is built once per mention session
    /// (when `@` is first typed), not on every render. Consumed by `ChatComposer`.
    var mentionCandidates: () -> [MentionCandidate] = { [] }
    var onNewChat: () -> Void = {}
    var onOpenHistory: () -> Void = {}
    /// Fired when the user taps an action button Claude suggested in a message.
    var onSuggestedAction: (SuggestedAction) -> Void = { _ in }

    /// Suggested-prompt chips, refreshed on appear and between chat turns rather
    /// than recomputed every render — keeps the cluster-watch churn out of body.
    @State private var cachedPrompts: [SuggestedPrompt] = []
    @FocusState private var inputFocused: Bool
    /// True while the scroll is parked at (or near) the bottom. Autoscroll follows
    /// new content only when pinned; scrolling up unpins it until the user returns
    /// to the bottom or taps the jump-to-bottom button.
    @State private var isAtBottom = true
    /// Latest scroll viewport height, used to derive distance-from-bottom.
    @State private var viewportHeight: CGFloat = 0

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
                    // Report the content's bottom edge in the scroll's coordinate
                    // space so we can tell how far from the bottom the user is.
                    .background(GeometryReader { geo in
                        Color.clear.preference(
                            key: ScrollBottomKey.self,
                            value: geo.frame(in: .named(Self.scrollSpace)).maxY
                        )
                    })
                }
                .coordinateSpace(name: Self.scrollSpace)
                .background(Theme.Surface.elevated)
                // Track the viewport height — needed to compute distance-to-bottom.
                .background(GeometryReader { vp in
                    Color.clear
                        .onAppear { viewportHeight = vp.size.height }
                        .onChange(of: vp.size.height) { _, h in viewportHeight = h }
                })
                .onPreferenceChange(ScrollBottomKey.self) { contentBottom in
                    // At the bottom, content's maxY ≈ viewport height; scrolling up
                    // pushes it larger. A small threshold absorbs sub-pixel jitter.
                    let atBottom = contentBottom - viewportHeight < Self.atBottomThreshold
                    if atBottom != isAtBottom { isAtBottom = atBottom }
                }
                // New message / tool card: follow only if pinned to the bottom.
                .onChange(of: viewModel.messages.count) { _, _ in
                    scrollToBottomIfPinned(proxy, animated: true)
                }
                // Streaming text grows the last bubble without changing the count —
                // follow that too, unanimated so it reads as smooth tailing.
                .onChange(of: viewModel.messages.last?.text) { _, _ in
                    scrollToBottomIfPinned(proxy, animated: false)
                }
                // A jump-to-bottom affordance, shown only when scrolled up. Tapping
                // it re-pins autoscroll (the preference flips isAtBottom back true).
                .overlay(alignment: .bottomTrailing) {
                    if !isAtBottom && !viewModel.messages.isEmpty {
                        scrollToBottomButton(proxy)
                            .padding(.trailing, 16).padding(.bottom, 12)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
                .animation(.easeInOut(duration: 0.15), value: isAtBottom)
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

    /// Named coordinate space for measuring scroll content against its viewport.
    private static let scrollSpace = "chatScroll"
    /// Px slack below which we consider the scroll "at the bottom" — absorbs
    /// fractional layout offsets and the bottom content padding.
    private static let atBottomThreshold: CGFloat = 24

    /// Scroll to the newest message, but only while the user is pinned to the
    /// bottom. Once they scroll up, content keeps arriving without yanking them
    /// back down.
    private func scrollToBottomIfPinned(_ proxy: ScrollViewProxy, animated: Bool) {
        guard isAtBottom, let last = viewModel.messages.last else { return }
        if animated {
            withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
        } else {
            proxy.scrollTo(last.id, anchor: .bottom)
        }
    }

    /// Floating "jump to newest" button, shown only when scrolled up. Tapping it
    /// scrolls to the bottom, which re-pins autoscroll via the preference update.
    private func scrollToBottomButton(_ proxy: ScrollViewProxy) -> some View {
        Button {
            if let last = viewModel.messages.last {
                withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        } label: {
            Image(systemName: "arrow.down")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Theme.Foreground.primary)
                .frame(width: 30, height: 30)
                .background(Theme.Surface.field)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(Theme.Border.strong, lineWidth: 1))
                .shadow(color: .black.opacity(0.3), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .help("Scroll to latest")
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

/// Carries the chat content's bottom edge (maxY) in the scroll's coordinate space
/// up to the ScrollView, so it can decide whether the user is pinned to the bottom.
private struct ScrollBottomKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
