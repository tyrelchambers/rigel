import SwiftUI

/// Pinned above the composer while Claude is working. Shows an animated status
/// line (rotating verb + elapsed seconds + interrupt hint) and, when reasoning
/// has streamed in, a collapsible dim view of the live thinking text.
struct ThinkingPane: View {
    let thinking: String
    let startedAt: Date?
    var onInterrupt: () -> Void = {}

    @State private var expanded = true
    @State private var verbIndex = 0

    /// Tasteful, grounded verbs — this is an admin tool, not a toy.
    private static let verbs = ["Thinking", "Investigating", "Reasoning", "Inspecting", "Working"]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            statusRow
            if expanded, !thinking.isEmpty {
                reasoningBody
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.sunken)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
        .transition(.move(edge: .bottom).combined(with: .opacity))
        // Rotate the verb on a view-scoped timer so ChatView.body never re-renders.
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                withAnimation(.easeInOut(duration: 0.3)) {
                    verbIndex = (verbIndex + 1) % Self.verbs.count
                }
            }
        }
    }

    private var statusRow: some View {
        HStack(spacing: 6) {
            Image(systemName: "sparkle")
                .font(.system(size: 11))
                .foregroundStyle(Theme.Accent.primary)
                .symbolEffect(.pulse, options: .repeating)
            ShimmerText(Self.verbs[verbIndex] + "…")
            elapsedLabel
            Text("· esc to interrupt")
                .font(Theme.Font.body(10))
                .foregroundStyle(Theme.Foreground.tertiary)
            Spacer(minLength: 4)
            Button { withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() } } label: {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            .buttonStyle(.plain)
            .help(expanded ? "Hide reasoning" : "Show reasoning")
            .disabled(thinking.isEmpty)
            .opacity(thinking.isEmpty ? 0 : 1)
        }
    }

    @ViewBuilder private var elapsedLabel: some View {
        if let startedAt {
            TimelineView(.periodic(from: startedAt, by: 1)) { ctx in
                let secs = max(0, Int(ctx.date.timeIntervalSince(startedAt)))
                Text("\(secs)s")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
        }
    }

    private var reasoningBody: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(thinking)
                    .font(Theme.Font.body(11))
                    .italic()
                    .foregroundStyle(Theme.Foreground.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .id("thinkingTail")
            }
            .frame(maxHeight: 90)
            .mask(
                LinearGradient(
                    colors: [.clear, .black, .black, .black],
                    startPoint: .top, endPoint: .bottom
                )
            )
            .onChange(of: thinking) { _, _ in
                withAnimation { proxy.scrollTo("thinkingTail", anchor: .bottom) }
            }
        }
    }
}

/// A subtle left-to-right shimmer used on the active thinking verb.
struct ShimmerText: View {
    let text: String
    @State private var phase: CGFloat = -1

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Theme.Font.body(11, weight: .medium))
            .foregroundStyle(Theme.Foreground.secondary)
            .overlay(
                LinearGradient(
                    colors: [.clear, Theme.Foreground.primary.opacity(0.9), .clear],
                    startPoint: .leading, endPoint: .trailing
                )
                .frame(width: 60)
                .offset(x: phase * 120)
                .blendMode(.plusLighter)
                .mask(Text(text).font(Theme.Font.body(11, weight: .medium)))
            )
            .task {
                while !Task.isCancelled {
                    withAnimation(.linear(duration: 1.4)) { phase = 1 }
                    try? await Task.sleep(nanoseconds: 1_400_000_000)
                    phase = -1
                }
            }
    }
}
