import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// Lists saved past conversations. Click → resume. Click trash → delete.
struct ChatHistorySheet: View {
    let entries: [ChatHistoryEntry]
    let onResume: (ChatHistoryEntry) -> Void
    let onDelete: (ChatHistoryEntry) -> Void
    let onClose: () -> Void

    @State private var search: String = ""

    private var filtered: [ChatHistoryEntry] {
        guard !search.isEmpty else { return entries }
        let q = search.lowercased()
        return entries.filter { e in
            if e.title.lowercased().contains(q) { return true }
            if e.context.lowercased().contains(q) { return true }
            return e.messages.contains { $0.text.lowercased().contains(q) }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            searchBar
            Divider().background(Theme.Border.subtle)
            if filtered.isEmpty {
                emptyState
            } else {
                list
            }
        }
        .frame(width: 560, height: 520)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.strong, lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Accent.primary)
            Text("Chat history")
                .font(Theme.Font.body(13, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Text("\(entries.count)")
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.tertiary)
            Spacer()
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(width: 22, height: 22)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var searchBar: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 10))
                .foregroundStyle(Theme.Foreground.tertiary)
            TextField("search title, context, messages…", text: $search)
                .textFieldStyle(.plain)
                .font(Theme.Font.mono(11))
                .foregroundStyle(Theme.Foreground.primary)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.Surface.sunken)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 28))
                .foregroundStyle(Theme.Foreground.tertiary)
            Text("No saved chats yet")
                .font(Theme.Font.body(12, weight: .medium))
                .foregroundStyle(Theme.Foreground.secondary)
            Text("Conversations are auto-saved once you send a message.")
                .font(Theme.Font.body(11))
                .foregroundStyle(Theme.Foreground.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                ForEach(filtered) { entry in
                    row(entry)
                }
            }
            .padding(6)
        }
    }

    private func row(_ entry: ChatHistoryEntry) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title)
                    .font(Theme.Font.body(12, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(entry.context)
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Foreground.tertiary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Theme.Surface.sunken)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    Text(ageDescription(entry.updatedAt))
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Foreground.tertiary)
                    Text("\(entry.messages.count) msg\(entry.messages.count == 1 ? "" : "s")")
                        .font(Theme.Font.mono(10))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
            }
            Spacer()
            Button {
                onDelete(entry)
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .frame(width: 24, height: 24)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .help("Delete this chat")
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
        .contentShape(Rectangle())
        .onTapGesture { onResume(entry) }
        .contextMenu {
            Button("Copy as Markdown") { copyAsMarkdown(entry) }
            Button("Save to file…") { saveToFile(entry) }
            Divider()
            Button("Delete chat", role: .destructive) { onDelete(entry) }
        }
    }

    private func markdown(for entry: ChatHistoryEntry) -> String {
        var out = ["# \(entry.title)",
                   "",
                   "_Context: \(entry.context) · Started: \(entry.createdAt) · Updated: \(entry.updatedAt)_",
                   ""]
        for m in entry.messages {
            let header: String
            switch m.role {
            case "user":      header = "## You"
            case "assistant": header = "## Claude"
            default:          header = "### System"
            }
            out.append(header)
            out.append(m.text)
            out.append("")
        }
        return out.joined(separator: "\n")
    }

    private func copyAsMarkdown(_ entry: ChatHistoryEntry) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(markdown(for: entry), forType: .string)
    }

    private func saveToFile(_ entry: ChatHistoryEntry) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = entry.title
            .lowercased()
            .replacingOccurrences(of: " ", with: "-")
            .appending(".md")
        if panel.runModal() == .OK, let url = panel.url {
            try? markdown(for: entry).write(to: url, atomically: true, encoding: .utf8)
        }
    }

    private func ageDescription(_ d: Date) -> String {
        let dt = Date().timeIntervalSince(d)
        if dt < 60 { return "just now" }
        if dt < 3600 { return "\(Int(dt/60))m ago" }
        if dt < 86400 { return "\(Int(dt/3600))h ago" }
        return "\(Int(dt/86400))d ago"
    }
}
