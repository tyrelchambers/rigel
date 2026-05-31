import SwiftUI

/// Shared namespace selector shown at the top of the panel column on
/// namespace-scoped tabs. Binds to the single `ClusterCache.namespaceFilter`.
/// A searchable dropdown: an "All namespaces" item plus one row per live
/// namespace, filterable by a text field.
struct NamespaceBar: View {
    @Bindable var cache: ClusterCache
    @State private var menuOpen = false
    @State private var query = ""

    private var namespaces: [String] {
        cache.namespaces.map { $0.metadata.name }.sorted {
            $0.localizedStandardCompare($1) == .orderedAscending
        }
    }

    private var filtered: [String] {
        guard !query.isEmpty else { return namespaces }
        return namespaces.filter { $0.localizedCaseInsensitiveContains(query) }
    }

    private var currentLabel: String {
        cache.namespaceFilter ?? "All namespaces"
    }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "square.dashed")
                .font(.system(size: 11))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text("Namespace")
                .font(Theme.Font.body(11, weight: .medium))
                .foregroundStyle(Theme.Foreground.tertiary)

            Button {
                menuOpen.toggle()
            } label: {
                HStack(spacing: 6) {
                    Text(currentLabel)
                        .font(Theme.Font.mono(12, weight: .medium))
                        .foregroundStyle(Theme.Foreground.primary)
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Border.strong, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .help("Select namespace filter")
            .popover(isPresented: $menuOpen, arrowEdge: .bottom) {
                menu
            }
            // Clear the search whenever the popover closes (button re-tap,
            // outside-click, or selection) so it always reopens unfiltered.
            .onChange(of: menuOpen) { _, isOpen in
                if !isOpen { query = "" }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var menu: some View {
        VStack(spacing: 0) {
            TextField("Filter namespaces…", text: $query)
                .textFieldStyle(.plain)
                .font(Theme.Font.body(12))
                .padding(.horizontal, 10).padding(.vertical, 8)
            Divider()
            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(spacing: 0) {
                    row(label: "All namespaces", value: nil)
                    ForEach(filtered, id: \.self) { ns in
                        row(label: ns, value: ns)
                    }
                }
            }
            .frame(maxHeight: 320)
        }
        .frame(width: 260)
    }

    private func row(label: String, value: String?) -> some View {
        let isActive = cache.namespaceFilter == value
        return Button {
            cache.namespaceFilter = value
            menuOpen = false
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(isActive ? Theme.Accent.primary : Color.clear)
                    .frame(width: 12)
                Text(label)
                    .font(Theme.Font.mono(12, weight: isActive ? .semibold : .regular))
                    .foregroundStyle(Theme.Foreground.primary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
