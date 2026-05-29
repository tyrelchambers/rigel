import SwiftUI
import AppKit

/// Manage sheet for a single ConfigMap. Key list with plaintext values + per-row
/// copy buttons. Action bar (Edit · Delete); callbacks wired by MainWindow.
/// Binary keys are listed read-only (the editor only touches plaintext `data`).
struct ConfigMapManageSheet: View {
    let configMap: ConfigMap
    let onClose: () -> Void
    let onViewYAML: () -> Void
    let onEdit: (ConfigMap) -> Void
    let onDelete: (ConfigMap) -> Void

    @State private var copiedKey: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    controlsBlock
                    summary
                    keysBlock
                }
                .padding(16)
            }
            .background(Theme.Surface.sunken)
        }
        .frame(width: 760, height: 660)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.strong, lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.plaintext.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Accent.primary)
            VStack(alignment: .leading, spacing: 2) {
                Text(configMap.metadata.name)
                    .font(Theme.Font.mono(15, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.primary)
                Text("ConfigMap · \(configMap.metadata.namespace ?? "default")")
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            Spacer()
            Button(action: onViewYAML) {
                HStack(spacing: 5) {
                    Image(systemName: "doc.text").font(.system(size: 10))
                    Text("YAML").font(Theme.Font.body(13, weight: .medium))
                }
                .foregroundStyle(Theme.Foreground.secondary)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Border.strong, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
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

    private var controlsBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("CONTROLS")
                .font(Theme.Font.body(11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            HStack(spacing: 8) {
                actionButton(label: "Edit", icon: "pencil", tint: Theme.Accent.primary) {
                    onEdit(configMap)
                }
                actionButton(label: "Delete", icon: "trash", tint: Theme.Status.failed) {
                    onDelete(configMap)
                }
                Spacer()
                if !(configMap.binaryData ?? [:]).isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "info.circle.fill").font(.system(size: 10))
                        Text("HAS BINARY KEYS — editor touches plaintext only")
                            .font(Theme.Font.body(10, weight: .semibold))
                            .tracking(0.5)
                    }
                    .foregroundStyle(Theme.Foreground.tertiary)
                }
            }
        }
        .padding(12)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private func actionButton(label: String, icon: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 10))
                Text(label).font(Theme.Font.body(12, weight: .medium))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(tint.opacity(0.12))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(tint.opacity(0.3), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("STATUS")
                .font(Theme.Font.body(11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            kvRow("Keys", "\(configMap.keyCount)")
            if !(configMap.binaryData ?? [:]).isEmpty {
                kvRow("Binary", "\((configMap.binaryData ?? [:]).count)")
            }
            if let age = ageDescription(configMap.metadata.creationTimestamp) {
                kvRow("Age", age)
            }
            if let labels = configMap.metadata.labels, !labels.isEmpty {
                kvRow("Labels", labels.sorted(by: { $0.key < $1.key }).map { "\($0.key)=\($0.value)" }.joined(separator: ", "))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private func kvRow(_ key: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(key)
                .font(Theme.Font.body(12, weight: .semibold))
                .tracking(0.3)
                .foregroundStyle(Theme.Foreground.tertiary)
                .textCase(.uppercase)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(Theme.Font.mono(13))
                .foregroundStyle(Theme.Foreground.primary)
                .textSelection(.enabled)
                .lineLimit(3)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
    }

    private func ageDescription(_ created: Date?) -> String? {
        guard let created else { return nil }
        let dt = Date().timeIntervalSince(created)
        if dt < 60 { return "\(Int(dt))s" }
        if dt < 3600 { return "\(Int(dt/60))m" }
        if dt < 86400 { return "\(Int(dt/3600))h" }
        return "\(Int(dt/86400))d"
    }

    private var keysBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("KEYS (\(configMap.keyCount))")
                .font(Theme.Font.body(11, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(Theme.Foreground.tertiary)
            if configMap.keyCount == 0 {
                Text("No data keys")
                    .font(Theme.Font.mono(13))
                    .foregroundStyle(Theme.Foreground.tertiary)
            } else {
                ForEach(configMap.keysSorted, id: \.self) { key in
                    keyCard(key)
                }
            }
        }
    }

    private func keyCard(_ key: String) -> some View {
        let value = configMap.data?[key]
        let isBinary = value == nil && configMap.binaryData?[key] != nil
        let bytes = isBinary ? configMap.binaryBytes(key) : (value?.utf8.count ?? 0)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: isBinary ? "doc.zipper" : "circle.dotted")
                    .font(.system(size: 9))
                    .foregroundStyle(Theme.Accent.primary)
                Text(key)
                    .font(Theme.Font.mono(13, weight: .medium))
                    .foregroundStyle(Theme.Foreground.primary)
                    .textSelection(.enabled)
                Text("\(bytes)B")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
                Spacer()
                if let value {
                    Button {
                        copy(key: key, value: value)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: copiedKey == key ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 9))
                            Text(copiedKey == key ? "copied" : "copy")
                                .font(Theme.Font.body(11))
                        }
                        .foregroundStyle(copiedKey == key ? Theme.Status.running : Theme.Foreground.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Theme.Surface.sunken)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    }
                    .buttonStyle(.plain)
                }
            }
            if let value {
                Text(value)
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(Theme.Surface.sunken)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.sm)
                            .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            } else {
                Text("<binary, \(bytes) bytes>")
                    .font(Theme.Font.mono(12))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
        }
        .padding(10)
        .background(Theme.Surface.elevated)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md)
                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    }

    private func copy(key: String, value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        copiedKey = key
        Task {
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            await MainActor.run {
                if copiedKey == key { copiedKey = nil }
            }
        }
    }
}
