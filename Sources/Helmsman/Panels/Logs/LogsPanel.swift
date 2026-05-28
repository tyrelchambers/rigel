import SwiftUI

struct LogsPanel: View {
    @Bindable var contextManager: ClusterContextManager
    @Bindable var viewModel: LogsViewModel
    let onAskClaude: (LogLine, [LogLine]) -> Void

    /// Bottom-most visible log id. When equal to the last filteredLine id we know
    /// the user is "stuck to the bottom" and we should auto-scroll new lines.
    @State private var bottomVisibleID: UUID? = nil
    @State private var stickToBottom = true

    var body: some View {
        HSplitView {
            sidebar
                .frame(minWidth: 220, idealWidth: 280, maxWidth: 360)
            streamPane
        }
        .background(Theme.Surface.primary)
        .onDisappear { viewModel.stop() }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Deployments")
                    .font(Theme.Font.body(13, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Spacer()
                Text("\(viewModel.availableDeployments.count)")
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            .padding(.horizontal, 12).padding(.vertical, 12)
            .background(Theme.Surface.elevated)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Theme.Border.subtle).frame(height: 1)
            }

            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(viewModel.availableDeployments) { dep in
                        DeploymentRow(
                            deployment: dep,
                            isSelected: isSelected(dep),
                            accentColor: accentColor(for: dep)
                        ) {
                            viewModel.select(dep, context: contextManager.active?.name)
                        }
                    }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 6)
            }
        }
        .background(Theme.Surface.sunken)
        .overlay(alignment: .trailing) {
            Rectangle().fill(Theme.Border.subtle).frame(width: 1)
        }
    }

    @ViewBuilder private var streamPane: some View {
        Group {
            if let dep = viewModel.selectedDeployment {
                stream(for: dep)
            } else {
                emptyState
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "text.alignleft")
                .font(.system(size: 30))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text("Pick a deployment to tail its logs")
                .font(Theme.Font.body(13, weight: .medium))
                .foregroundStyle(Theme.Foreground.secondary)
            Text("Click any deployment on the left to open a live log stream here.")
                .font(Theme.Font.body(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(40)
        .background(Theme.Surface.primary)
    }

    private func stream(for dep: Deployment) -> some View {
        VStack(spacing: 0) {
            streamHeader(for: dep)
            toolbar
            errorBanner
            scrollBody
        }
    }

    @ViewBuilder private var errorBanner: some View {
        if let err = viewModel.error {
            Text(err)
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Status.failed)
                .padding(.horizontal, 12).padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.Status.failed.opacity(0.08))
        }
    }

    private var scrollBody: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottomTrailing) {
                logScrollView(proxy: proxy)
                jumpButton(proxy: proxy)
            }
        }
    }

    private func logScrollView(proxy: ScrollViewProxy) -> some View {
        let scroll = ScrollView { logContent }
            .background(Theme.Surface.primary)
            .scrollPosition(id: $bottomVisibleID, anchor: .bottom)
        return scroll
            .onChange(of: bottomVisibleID, handleBottomVisibleChange)
            .onChange(of: viewModel.lines.count) { _, _ in
                guard stickToBottom, !viewModel.isPaused else { return }
                if let last = viewModel.filteredLines.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
    }

    private var logContent: some View {
        LazyVStack(alignment: .leading, spacing: 2) {
            ForEach(viewModel.filteredLines) { line in
                logRow(for: line)
            }
        }
        .scrollTargetLayout()
        .padding(.horizontal, 8).padding(.vertical, 4)
    }

    private func handleBottomVisibleChange(_ old: UUID?, _ new: UUID?) {
        stickToBottom = (new == nil) || (new == viewModel.filteredLines.last?.id)
    }

    private func logRow(for line: LogLine) -> some View {
        LogLineRow(line: line, color: Theme.Pod.palette[line.colorIndex])
            .id(line.id)
            .contextMenu {
                Button("Ask Claude about this line") {
                    onAskClaude(line, surroundingLines(of: line))
                }
            }
    }

    @ViewBuilder
    private func jumpButton(proxy: ScrollViewProxy) -> some View {
        if !stickToBottom {
            JumpToBottomButton {
                guard let last = viewModel.filteredLines.last else { return }
                withAnimation(.easeInOut(duration: 0.2)) {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
                stickToBottom = true
            }
            .padding(16)
        }
    }

    private func streamHeader(for dep: Deployment) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(accentColor(for: dep))
                .frame(width: 8, height: 8)
            Text(dep.metadata.name)
                .font(Theme.Font.mono(13, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Text(dep.metadata.namespace ?? "—")
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Theme.Surface.sunken)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Spacer()
            Button {
                viewModel.clearSelection()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .padding(6)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .help("Close log view")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.Foreground.tertiary)
                TextField("filter", text: $viewModel.filter)
                    .textFieldStyle(.plain)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.primary)
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Theme.Surface.sunken)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(Theme.Border.subtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            .frame(maxWidth: 240)

            Spacer(minLength: 4)

            IconToggle(isOn: $viewModel.hideProbes, systemImage: "heart.slash", help: "Hide probe traffic (kube-probe / healthz / readyz)")
            IconButton(systemImage: viewModel.isPaused ? "play.fill" : "pause.fill",
                       help: viewModel.isPaused ? "Resume" : "Pause") {
                viewModel.isPaused.toggle()
            }
            IconButton(systemImage: "trash", help: "Clear") {
                viewModel.clear()
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private func isSelected(_ dep: Deployment) -> Bool {
        let key = "\(dep.metadata.namespace ?? "default")/\(dep.metadata.name)"
        return viewModel.selectedDeploymentKey == key
    }

    private func accentColor(for dep: Deployment) -> Color {
        let key = "\(dep.metadata.namespace ?? "default")/\(dep.metadata.name)"
        return Theme.Pod.palette[abs(key.hashValue) % Theme.Pod.palette.count]
    }

    private func surroundingLines(of line: LogLine) -> [LogLine] {
        guard let idx = viewModel.lines.firstIndex(where: { $0.id == line.id }) else { return [] }
        let start = max(0, idx - 5)
        let end = min(viewModel.lines.count, idx + 6)
        return Array(viewModel.lines[start..<end])
    }
}

private struct DeploymentRow: View {
    let deployment: Deployment
    let isSelected: Bool
    let accentColor: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Rectangle()
                    .fill(isSelected ? accentColor : Color.clear)
                    .frame(width: 2)

                VStack(alignment: .leading, spacing: 2) {
                    Text(deployment.metadata.name)
                        .font(Theme.Font.body(12, weight: .medium))
                        .foregroundStyle(isSelected ? Theme.Foreground.primary : Theme.Foreground.secondary)
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        Text(deployment.metadata.namespace ?? "—")
                            .font(Theme.Font.mono(10))
                            .foregroundStyle(Theme.Foreground.tertiary)
                        Text("·")
                            .foregroundStyle(Theme.Foreground.tertiary)
                        let ready = deployment.status?.readyReplicas ?? 0
                        let total = deployment.status?.replicas ?? 0
                        Text("\(ready)/\(total)")
                            .font(Theme.Font.mono(10))
                            .foregroundStyle(ready < total ? Theme.Status.failed : Theme.Foreground.tertiary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(isSelected ? Theme.Surface.elevated : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        }
        .buttonStyle(.plain)
    }
}

private struct IconButton: View {
    let systemImage: String
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.Foreground.secondary)
                .frame(width: 24, height: 24)
                .background(Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

private struct IconToggle: View {
    @Binding var isOn: Bool
    let systemImage: String
    let help: String

    var body: some View {
        Button { isOn.toggle() } label: {
            Image(systemName: systemImage)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(isOn ? Theme.Accent.primary : Theme.Foreground.secondary)
                .frame(width: 24, height: 24)
                .background(isOn ? Theme.Accent.primaryDim : Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(isOn ? Theme.Accent.primary.opacity(0.4) : Theme.Border.subtle, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

private struct JumpToBottomButton: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 10, weight: .bold))
                Text("Jump to latest")
                    .font(Theme.Font.body(11, weight: .medium))
            }
            .foregroundStyle(Theme.Foreground.primary)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Theme.Accent.primary)
            .clipShape(Capsule())
            .shadow(color: .black.opacity(0.4), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
    }
}

struct LogLineRow: View {
    let line: LogLine
    let color: Color
    @State private var isExpanded = false

    private var isError: Bool {
        let lower = line.text.lowercased()
        return lower.contains("error") || lower.contains("fatal") || lower.contains("panic")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Rectangle().fill(color).frame(width: 2).frame(maxHeight: .infinity)

            Text(line.sourcePod)
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(color)
                .frame(width: 150, alignment: .leading)
                .lineLimit(1)
                .truncationMode(.middle)

            if let ts = line.timestamp {
                Text(ts.formatted(date: .omitted, time: .standard))
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(width: 80, alignment: .leading)
            }

            Text(line.text)
                .font(Theme.Font.mono(11))
                .foregroundStyle(isError ? Theme.Status.failed : Theme.Foreground.primary)
                .textSelection(.enabled)
                .lineLimit(isExpanded ? nil : 1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .onTapGesture { isExpanded.toggle() }
        }
        .padding(.vertical, 2)
        .frame(minHeight: 18, alignment: .top)
    }
}
