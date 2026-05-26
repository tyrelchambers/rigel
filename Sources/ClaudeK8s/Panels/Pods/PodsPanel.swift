import SwiftUI

struct PodsPanel: View {
    @Bindable var contextManager: ClusterContextManager
    @State private var viewModel = PodsViewModel()
    @State private var selection: Pod.ID? = nil

    let onAskClaude: (Pod) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Pods").font(.headline)
                Spacer()
                if viewModel.isLoading { ProgressView().controlSize(.small) }
                Text("\(viewModel.pods.count)").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)

            if let err = viewModel.error {
                Text(err).font(.caption).foregroundStyle(.red).padding(.horizontal, 12)
            }

            Table(viewModel.pods, selection: $selection) {
                TableColumn("Namespace") { Text($0.metadata.namespace ?? "—") }
                TableColumn("Name") { Text($0.metadata.name) }
                TableColumn("Status") { pod in
                    Text(pod.status?.phase ?? "—")
                        .foregroundStyle(statusColor(pod))
                }
                TableColumn("Restarts") { pod in
                    Text("\(pod.status?.containerStatuses?.map(\.restartCount).reduce(0, +) ?? 0)")
                }
                TableColumn("Node") { Text($0.spec?.nodeName ?? "—") }
            }
            .contextMenu(forSelectionType: Pod.ID.self) { ids in
                if let id = ids.first, let pod = viewModel.pods.first(where: { $0.id == id }) {
                    Button("Ask Claude about this pod") { onAskClaude(pod) }
                }
            }
        }
        .onAppear { viewModel.start(context: contextManager.active?.name) }
        .onDisappear { viewModel.stop() }
        .onChange(of: contextManager.active) { _, newValue in
            viewModel.start(context: newValue?.name)
        }
    }

    private func statusColor(_ pod: Pod) -> Color {
        switch pod.status?.phase {
        case "Running": return .green
        case "Pending": return .yellow
        case "Failed": return .red
        default: return .secondary
        }
    }
}
