import SwiftUI

struct ChatView: View {
    @Bindable var viewModel: ChatViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Claude").font(.headline)
                if viewModel.isStreaming {
                    ProgressView().controlSize(.small)
                }
                Spacer()
                if let sid = viewModel.sessionId {
                    Text("session: \(sid.prefix(8))")
                        .font(.caption2).monospaced()
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)

            Divider()

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(viewModel.messages) { msg in
                            MessageBubble(message: msg).id(msg.id)
                        }
                    }
                    .padding(12)
                }
                .onChange(of: viewModel.messages.count) { _, _ in
                    if let last = viewModel.messages.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }

            Divider()

            HStack(spacing: 8) {
                TextField("Ask Claude…", text: $viewModel.inputText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...6)
                    .onSubmit { sendInput() }
                Button("Send", action: sendInput)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(viewModel.inputText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(8)
        }
        .sheet(item: $viewModel.pendingPermission) { pending in
            PermissionSheet(
                pending: pending,
                onApprove: { viewModel.answerPermission(allow: true) },
                onDeny: { viewModel.answerPermission(allow: false) }
            )
        }
        .onAppear { viewModel.start() }
        .onDisappear { viewModel.stop() }
    }

    private func sendInput() {
        let text = viewModel.inputText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        viewModel.send(text)
        viewModel.inputText = ""
    }
}

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            roleIcon
            VStack(alignment: .leading, spacing: 4) {
                Text(MessageRenderer.render(message.text))
                    .textSelection(.enabled)
            }
            .padding(8)
            .background(bg)
            .cornerRadius(8)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder private var roleIcon: some View {
        switch message.role {
        case .user: Image(systemName: "person.crop.circle.fill").foregroundStyle(.blue)
        case .assistant: Image(systemName: "sparkles").foregroundStyle(.purple)
        case .system: Image(systemName: "gear").foregroundStyle(.secondary)
        }
    }

    private var bg: Color {
        switch message.role {
        case .user: return Color.blue.opacity(0.12)
        case .assistant: return Color.purple.opacity(0.08)
        case .system: return Color.secondary.opacity(0.10)
        }
    }
}
