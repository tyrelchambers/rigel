import SwiftUI

enum ConfigMapEditorMode: Identifiable {
    case create
    case edit(ConfigMap)

    var id: String {
        switch self {
        case .create: return "__create__"
        case .edit(let c): return c.id
        }
    }

    var isNew: Bool { if case .create = self { return true } else { return false } }
}

/// Create-or-edit form for a ConfigMap. Plaintext key/value rows (values are
/// often whole config files, so each gets a multi-line editor). Builds a
/// `ConfigMap` value and hands it back via `onSubmit` — the caller submits
/// `.applyConfigMap` through the normal WorkloadConfirmSheet flow. On `.edit`,
/// name + namespace are read-only and any `binaryData` is carried through.
struct ConfigMapEditorSheet: View {
    let mode: ConfigMapEditorMode
    let onSubmit: (_ configMap: ConfigMap, _ isNew: Bool) -> Void
    let onCancel: () -> Void

    @State private var name: String
    @State private var namespace: String
    @State private var rows: [KVRow]

    /// Preserved unchanged across an edit (the form can't touch binary values).
    private let originalBinaryData: [String: String]?

    init(
        mode: ConfigMapEditorMode,
        onSubmit: @escaping (_ configMap: ConfigMap, _ isNew: Bool) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.mode = mode
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        switch mode {
        case .create:
            _name = State(initialValue: "")
            _namespace = State(initialValue: "default")
            _rows = State(initialValue: [KVRow(key: "", value: "")])
            originalBinaryData = nil
        case .edit(let cm):
            _name = State(initialValue: cm.metadata.name)
            _namespace = State(initialValue: cm.metadata.namespace ?? "default")
            let seeded = (cm.data ?? [:]).sorted { $0.key < $1.key }.map { KVRow(key: $0.key, value: $0.value) }
            _rows = State(initialValue: seeded.isEmpty ? [KVRow(key: "", value: "")] : seeded)
            originalBinaryData = cm.binaryData
        }
    }

    private var canSubmit: Bool {
        let keyed = rows.filter { !$0.key.trimmingCharacters(in: .whitespaces).isEmpty }
        // No duplicate keys, and a non-empty name.
        let keys = keyed.map { $0.key.trimmingCharacters(in: .whitespaces) }
        return !name.trimmingCharacters(in: .whitespaces).isEmpty
            && Set(keys).count == keys.count
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    identityBlock
                    dataBlock
                    if originalBinaryData?.isEmpty == false {
                        Text("\(originalBinaryData!.count) binary key(s) preserved unchanged.")
                            .font(Theme.Font.mono(10))
                            .foregroundStyle(Theme.Foreground.tertiary)
                    }
                }
                .padding(16)
            }
            .background(Theme.Surface.sunken)
            Divider().background(Theme.Border.subtle)
            footer
        }
        .frame(width: 760, height: 680)
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
            Text(mode.isNew ? "New ConfigMap" : "Edit \(name)")
                .font(Theme.Font.mono(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)
            Spacer()
            Button(action: onCancel) {
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

    private var footer: some View {
        HStack {
            Spacer()
            Button("Cancel", action: onCancel)
                .buttonStyle(.plain)
                .font(Theme.Font.body(13))
                .foregroundStyle(Theme.Foreground.secondary)
                .padding(.horizontal, 12).padding(.vertical, 6)
            Button {
                onSubmit(buildConfigMap(), mode.isNew)
            } label: {
                Text(mode.isNew ? "Create" : "Apply changes")
                    .font(Theme.Font.body(13, weight: .semibold))
                    .foregroundStyle(canSubmit ? Theme.Foreground.inverse : Theme.Foreground.tertiary)
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .background(canSubmit ? Theme.Accent.primary : Theme.Surface.sunken)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit)
            .keyboardShortcut(.defaultAction)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private func sectionTitle(_ t: String) -> some View {
        Text(t)
            .font(Theme.Font.body(11, weight: .semibold))
            .tracking(0.5)
            .foregroundStyle(Theme.Foreground.tertiary)
    }

    private func field(_ placeholder: String, text: Binding<String>, readOnly: Bool = false) -> some View {
        TextField(placeholder, text: text)
            .textFieldStyle(.plain)
            .font(Theme.Font.mono(12))
            .foregroundStyle(readOnly ? Theme.Foreground.tertiary : Theme.Foreground.primary)
            .disabled(readOnly)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(Theme.Surface.sunken)
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var identityBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("IDENTITY")
            HStack(spacing: 8) {
                field("name", text: $name, readOnly: !mode.isNew)
                field("namespace", text: $namespace, readOnly: !mode.isNew)
            }
        }
    }

    private var dataBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                sectionTitle("DATA")
                Spacer()
                addButton { rows.append(KVRow(key: "", value: "")) }
            }
            ForEach(rows.indices, id: \.self) { i in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        field("key (e.g. app.conf)", text: $rows[i].key)
                        removeButton { rows.remove(at: i) }
                    }
                    TextEditor(text: $rows[i].value)
                        .font(Theme.Font.mono(12))
                        .foregroundStyle(Theme.Foreground.primary)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 64, maxHeight: 200)
                        .padding(6)
                        .background(Theme.Surface.sunken)
                        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                }
            }
        }
    }

    private func addButton(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Theme.Accent.primary)
                .frame(width: 22, height: 22)
                .background(Theme.Accent.primary.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }

    private func removeButton(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "minus")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Theme.Status.failed)
                .frame(width: 22, height: 22)
                .background(Theme.Status.failed.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
        .buttonStyle(.plain)
    }

    private func buildConfigMap() -> ConfigMap {
        var data: [String: String] = [:]
        for row in rows {
            let key = row.key.trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else { continue }
            data[key] = row.value
        }
        return ConfigMap.draft(
            name: name.trimmingCharacters(in: .whitespaces),
            namespace: namespace.trimmingCharacters(in: .whitespaces),
            data: data,
            binaryData: originalBinaryData
        )
    }
}
