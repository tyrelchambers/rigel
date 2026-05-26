import SwiftUI

struct MainWindow: View {
    @State private var contextManager = ClusterContextManager()
    @State private var chat = ChatViewModel()
    @State private var selectedPanel: PanelKind = .pods

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                NavStrip(selection: $selectedPanel)

                HSplitView {
                    panelView
                        .frame(minWidth: 400, idealWidth: 720, maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(NSColor.windowBackgroundColor))

                    ChatView(viewModel: chat)
                        .frame(minWidth: 320, idealWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(NSColor.controlBackgroundColor))
                }
            }
            StatusBar()
        }
        .onAppear {
            contextManager.reload()
            if let ctx = contextManager.active?.name {
                let saved = SessionStore.shared.sessionId(for: ctx)
                chat.start(resumingSessionId: saved)
            }
        }
        .onChange(of: contextManager.active) { _, newCtx in
            if let ctx = newCtx?.name {
                let saved = SessionStore.shared.sessionId(for: ctx)
                chat.stop()
                chat.start(resumingSessionId: saved)
            }
        }
        .onChange(of: chat.sessionId) { _, newSid in
            if let sid = newSid, let ctx = contextManager.active?.name {
                SessionStore.shared.setSessionId(sid, for: ctx)
            }
        }
    }

    @ViewBuilder private var panelView: some View {
        switch selectedPanel {
        case .pods:
            PodsPanel(contextManager: contextManager) { pod in
                handoffPod(pod)
            }
        case .logs:
            // LogsPanel and its handoff are added in Tasks 2-8.
            // Temporary stub so the project keeps compiling while Plan 2 lands.
            VStack {
                Text("Logs panel coming online (Tasks 2-8 in progress)")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func handoffPod(_ pod: Pod) {
        Task {
            guard let ctx = contextManager.active?.name else { return }
            do {
                let client = try KubectlClient(context: ctx)
                async let describeData: Data = runProcess(
                    client.kubectl,
                    args: ["--context", ctx, "describe", "pod", pod.metadata.name, "-n", pod.metadata.namespace ?? "default"]
                )
                async let eventsData: Data = runProcess(
                    client.kubectl,
                    args: ["--context", ctx, "get", "events", "-n", pod.metadata.namespace ?? "default",
                           "--field-selector", "involvedObject.name=\(pod.metadata.name)"]
                )
                let describeBytes = (try? await describeData) ?? Data()
                let eventsBytes = (try? await eventsData) ?? Data()
                let describe = String(data: describeBytes, encoding: .utf8) ?? ""
                let events = String(data: eventsBytes, encoding: .utf8) ?? ""

                let prompt = ContextHandoffBuilder.build(.pod(pod, describe: describe, recentEvents: events))
                await MainActor.run { chat.sendHandoff(prompt) }
            } catch {
                await MainActor.run { chat.error = "\(error)" }
            }
        }
    }
}
