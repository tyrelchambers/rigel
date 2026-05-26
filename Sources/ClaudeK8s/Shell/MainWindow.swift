import SwiftUI

struct MainWindow: View {
    @State private var contextManager = ClusterContextManager()
    @State private var chat = ChatViewModel()

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                NavStrip()

                HSplitView {
                    PodsPanel(contextManager: contextManager) { pod in
                        handoff(pod: pod)
                    }
                    .frame(minWidth: 400, idealWidth: 720, maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(NSColor.windowBackgroundColor))

                    ChatView(viewModel: chat)
                        .frame(minWidth: 320, idealWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(NSColor.controlBackgroundColor))
                }
            }
            StatusBar()
        }
        .onAppear { contextManager.reload() }
    }

    private func handoff(pod: Pod) {
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
