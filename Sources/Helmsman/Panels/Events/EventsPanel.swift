import SwiftUI

struct EventsPanel: View {
    @Bindable var viewModel: EventsViewModel
    let onAskClaude: (K8sEvent) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            filterBar
            timelineRibbon

            if let err = viewModel.error {
                Text(err)
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Status.failed)
                    .padding(.horizontal, 16).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Status.failed.opacity(0.08))
            }

            list
        }
        .background(Theme.Surface.primary)
    }

    private var header: some View {
        HStack(spacing: 12) {
            PanelTitle(.events)
            Text("\(viewModel.filteredEvents.count)")
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.tertiary)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(Theme.Border.subtle)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            Spacer()
            PanelSearchField(text: $viewModel.search, maxWidth: 200)
            if viewModel.isLoading {
                ProgressView().controlSize(.small).tint(Theme.Accent.primary)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var filterBar: some View {
        HStack(spacing: 8) {
            ForEach(EventTypeFilter.allCases) { kind in
                FilterPill(label: kind.label, isActive: viewModel.typeFilter == kind, color: tint(for: kind)) {
                    viewModel.typeFilter = kind
                }
            }
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var timelineRibbon: some View {
        EventTimeline(buckets: Viz.eventBuckets(viewModel.cache.events, now: Date(), span: 3600, count: 60), span: 3600)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(Theme.Surface.elevated)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.Border.subtle).frame(height: 1) }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                ForEach(viewModel.filteredEvents) { event in
                    EventRow(event: event)
                        .contextMenu {
                            Button("Ask Claude about this event") {
                                onAskClaude(event)
                            }
                        }
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
        }
    }

    private func tint(for kind: EventTypeFilter) -> Color {
        switch kind {
        case .all:     return Theme.Foreground.secondary
        case .warning: return Theme.Status.failed
        case .normal:  return Theme.Status.running
        }
    }
}

private struct FilterPill: View {
    let label: String
    let isActive: Bool
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(isActive ? Theme.Foreground.inverse : Theme.Foreground.secondary)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(isActive ? color : Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(isActive ? Color.clear : Theme.Border.strong, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }
}

private struct EventRow: View {
    let event: K8sEvent
    @State private var isExpanded = false

    private var tint: Color {
        event.isWarning ? Theme.Status.failed : Theme.Status.running
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Rectangle().fill(tint).frame(width: 2).frame(maxHeight: .infinity)

            VStack(alignment: .leading, spacing: 0) {
                Text(event.relativeAge())
                    .font(Theme.Font.mono(9))
                    .foregroundStyle(Theme.Foreground.tertiary)
                if let count = event.count, count > 1 {
                    Text("×\(count)")
                        .font(Theme.Font.mono(9, weight: .semibold))
                        .foregroundStyle(Theme.Status.pending)
                }
            }
            .frame(width: 70, alignment: .leading)
            .help(event.absoluteWhen ?? "Unknown time")

            Text(event.type ?? "—")
                .font(Theme.Font.mono(9, weight: .semibold))
                .textCase(.uppercase)
                .foregroundStyle(tint)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(tint.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))

            Text(event.reason ?? "—")
                .font(Theme.Font.mono(10, weight: .medium))
                .foregroundStyle(Theme.Foreground.primary)
                .frame(width: 140, alignment: .leading)
                .lineLimit(1)
                .truncationMode(.tail)

            VStack(alignment: .leading, spacing: 1) {
                Text(target)
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(event.message ?? "")
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.primary)
                    .lineLimit(isExpanded ? nil : 1)
                    .truncationMode(.tail)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { isExpanded.toggle() }
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Theme.Surface.elevated.opacity(isExpanded ? 1 : 0))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var target: String {
        let kind = event.involvedObject?.kind ?? ""
        let name = event.involvedObject?.name ?? ""
        let ns = event.involvedObject?.namespace ?? ""
        if name.isEmpty { return "—" }
        return ns.isEmpty ? "\(kind)/\(name)" : "\(kind)/\(name)  ·  \(ns)"
    }
}
