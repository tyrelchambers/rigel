import SwiftUI

struct LogsPanel: View {
    @Bindable var contextManager: ClusterContextManager
    @State private var viewModel = LogsViewModel()
    let onAskClaude: (LogLine, [LogLine]) -> Void

    private static let palette: [Color] = [
        .blue, .green, .orange, .purple, .pink, .cyan, .yellow, .mint,
    ]

    var body: some View {
        HSplitView {
            // Left: deployment selector
            VStack(alignment: .leading, spacing: 0) {
                Text("Deployments").font(.headline).padding(.horizontal, 12).padding(.top, 8)
                List {
                    ForEach(viewModel.availableDeployments) { dep in
                        let key = "\(dep.metadata.namespace ?? "default")/\(dep.metadata.name)"
                        Button {
                            viewModel.toggleSelection(dep, context: contextManager.active?.name)
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: viewModel.selectedDeploymentKeys.contains(key) ? "checkmark.square.fill" : "square")
                                    .foregroundStyle(viewModel.selectedDeploymentKeys.contains(key) ? Color.accentColor : .secondary)
                                VStack(alignment: .leading) {
                                    Text(dep.metadata.name).font(.caption).lineLimit(1)
                                    HStack(spacing: 4) {
                                        Text(dep.metadata.namespace ?? "—")
                                        Text("·")
                                        let ready = dep.status?.readyReplicas ?? 0
                                        let total = dep.status?.replicas ?? 0
                                        Text("\(ready)/\(total)")
                                            .foregroundStyle(ready < total ? Color.red : .secondary)
                                    }
                                    .font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(minWidth: 240, idealWidth: 280)

            // Right: merged log stream
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    TextField("filter (case-insensitive substring)", text: $viewModel.filter)
                        .textFieldStyle(.roundedBorder)
                    Toggle("Hide probes", isOn: $viewModel.hideProbes)
                        .toggleStyle(.checkbox)
                        .help("Filters out 'kube-probe/' user-agent and common health endpoints (/healthz, /ready, /live, etc.)")
                    Button(viewModel.isPaused ? "Resume" : "Pause") {
                        viewModel.isPaused.toggle()
                    }
                    Button("Clear") { viewModel.clear() }
                }
                .padding(8)

                if let err = viewModel.error {
                    Text(err).font(.caption).foregroundStyle(.red).padding(.horizontal, 8)
                }

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 1) {
                            ForEach(viewModel.filteredLines) { line in
                                LogLineRow(line: line, color: Self.palette[line.colorIndex])
                                    .id(line.id)
                                    .contextMenu {
                                        Button("Ask Claude about this line") {
                                            let surrounding = surroundingLines(of: line)
                                            onAskClaude(line, surrounding)
                                        }
                                    }
                            }
                        }
                        .padding(.horizontal, 8).padding(.bottom, 8)
                    }
                    .onChange(of: viewModel.lines.count) { _, _ in
                        if !viewModel.isPaused, let last = viewModel.filteredLines.last {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }
        }
        .onAppear { viewModel.start(context: contextManager.active?.name) }
        .onDisappear { viewModel.stopAll() }
        .onChange(of: contextManager.active) { _, newCtx in
            viewModel.start(context: newCtx?.name)
        }
    }

    private func surroundingLines(of line: LogLine) -> [LogLine] {
        guard let idx = viewModel.lines.firstIndex(where: { $0.id == line.id }) else { return [] }
        let start = max(0, idx - 5)
        let end = min(viewModel.lines.count, idx + 6)
        return Array(viewModel.lines[start..<end])
    }
}

struct LogLineRow: View {
    let line: LogLine
    let color: Color

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Rectangle().fill(color).frame(width: 3)
            Text(line.sourcePod).font(.caption2).foregroundStyle(color).frame(width: 180, alignment: .leading)
            if let ts = line.timestamp {
                Text(ts.formatted(date: .omitted, time: .standard))
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            Text(line.text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .lineLimit(nil)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 1)
    }
}
