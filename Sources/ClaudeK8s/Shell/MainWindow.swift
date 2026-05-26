import SwiftUI

struct MainWindow: View {
    @State private var contextManager = ClusterContextManager()
    @State private var pendingHandoff: String? = nil  // wired to ChatViewModel in Task 18

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                NavStrip()

                HSplitView {
                    PodsPanel(contextManager: contextManager) { pod in
                        // Placeholder — Task 18 wires this to ChatViewModel.sendHandoff
                        pendingHandoff = "Ask Claude about pod \(pod.metadata.name)"
                    }
                    .frame(minWidth: 400, idealWidth: 720, maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(NSColor.windowBackgroundColor))

                    VStack {
                        Text(pendingHandoff ?? "Chat goes here").foregroundStyle(.secondary)
                    }
                    .frame(minWidth: 320, idealWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(NSColor.controlBackgroundColor))
                }
            }
            StatusBar()
        }
        .onAppear { contextManager.reload() }
    }
}
