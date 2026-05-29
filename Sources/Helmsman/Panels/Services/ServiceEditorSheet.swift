import SwiftUI

enum ServiceEditorMode: Identifiable {
    case create
    case edit(Service)

    var id: String {
        switch self {
        case .create: return "__create__"
        case .edit(let s): return s.id
        }
    }

    var isNew: Bool { if case .create = self { return true } else { return false } }
}

/// Create-or-edit form for a Service. Builds a `Service` value and hands it back
/// via `onSubmit` — the caller submits `.applyService` through the normal
/// WorkloadConfirmSheet flow. This sheet runs no mutating kubectl commands. On
/// `.edit`, name + namespace are read-only.
struct ServiceEditorSheet: View {
    let mode: ServiceEditorMode
    let onSubmit: (_ service: Service, _ isNew: Bool) -> Void
    let onCancel: () -> Void

    @State private var name: String
    @State private var namespace: String
    @State private var type: String
    @State private var selectorRows: [KVRow]
    @State private var portRows: [Service.PortDraft]

    private let protocols = ["TCP", "UDP", "SCTP"]

    init(
        mode: ServiceEditorMode,
        onSubmit: @escaping (_ service: Service, _ isNew: Bool) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.mode = mode
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        switch mode {
        case .create:
            _name = State(initialValue: "")
            _namespace = State(initialValue: "default")
            _type = State(initialValue: Service.clusterIP)
            _selectorRows = State(initialValue: [KVRow(key: "app", value: "")])
            _portRows = State(initialValue: [Service.PortDraft(name: "", port: "80", targetPort: "", protocolName: "TCP", nodePort: "")])
        case .edit(let svc):
            _name = State(initialValue: svc.metadata.name)
            _namespace = State(initialValue: svc.metadata.namespace ?? "default")
            _type = State(initialValue: svc.spec?.type ?? Service.clusterIP)
            let sel = (svc.spec?.selector ?? [:]).sorted { $0.key < $1.key }.map { KVRow(key: $0.key, value: $0.value) }
            _selectorRows = State(initialValue: sel.isEmpty ? [KVRow(key: "", value: "")] : sel)
            let ports = svc.portDrafts
            _portRows = State(initialValue: ports.isEmpty ? [Service.PortDraft(name: "", port: "80", targetPort: "", protocolName: "TCP", nodePort: "")] : ports)
        }
    }

    private var canSubmit: Bool {
        let validPorts = portRows.filter { Int($0.port.trimmingCharacters(in: .whitespaces)) != nil }
        return !name.trimmingCharacters(in: .whitespaces).isEmpty && !validPorts.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    identityBlock
                    selectorBlock
                    portsBlock
                }
                .padding(16)
            }
            .background(Theme.Surface.sunken)
            Divider().background(Theme.Border.subtle)
            footer
        }
        .frame(width: 760, height: 620)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.strong, lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "network")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Accent.primary)
            Text(mode.isNew ? "New Service" : "Edit \(name)")
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
                onSubmit(buildService(), mode.isNew)
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
                Picker("", selection: $type) {
                    ForEach(Service.selectableTypes, id: \.self) { Text($0).font(Theme.Font.mono(11)) }
                }
                .labelsHidden()
                .frame(width: 160)
            }
        }
    }

    private var selectorBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                sectionTitle("SELECTOR")
                Spacer()
                addButton { selectorRows.append(KVRow(key: "", value: "")) }
            }
            Text("Pods matching these labels back the service.")
                .font(Theme.Font.mono(10))
                .foregroundStyle(Theme.Foreground.tertiary)
            ForEach(selectorRows.indices, id: \.self) { i in
                HStack(spacing: 6) {
                    field("key", text: $selectorRows[i].key)
                    field("value", text: $selectorRows[i].value)
                    removeButton { selectorRows.remove(at: i) }
                }
            }
        }
    }

    private var portsBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                sectionTitle("PORTS")
                Spacer()
                addButton { portRows.append(Service.PortDraft(name: "", port: "", targetPort: "", protocolName: "TCP", nodePort: "")) }
            }
            HStack(spacing: 6) {
                Text("name").frame(maxWidth: .infinity, alignment: .leading)
                Text("port").frame(width: 70, alignment: .leading)
                Text("target").frame(width: 80, alignment: .leading)
                Text("proto").frame(width: 90, alignment: .leading)
                Text("nodePort").frame(width: 80, alignment: .leading)
                Spacer().frame(width: 22)
            }
            .font(Theme.Font.body(9, weight: .semibold))
            .foregroundStyle(Theme.Foreground.tertiary)
            ForEach(portRows.indices, id: \.self) { i in
                HStack(spacing: 6) {
                    field("name", text: $portRows[i].name)
                    field("80", text: $portRows[i].port).frame(width: 70)
                    field("=port", text: $portRows[i].targetPort).frame(width: 80)
                    Picker("", selection: $portRows[i].protocolName) {
                        ForEach(protocols, id: \.self) { Text($0).font(Theme.Font.mono(11)) }
                    }
                    .labelsHidden()
                    .frame(width: 90)
                    field("auto", text: $portRows[i].nodePort)
                        .frame(width: 80)
                        .disabled(type == Service.clusterIP)
                    removeButton { portRows.remove(at: i) }
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

    private func buildService() -> Service {
        var selector: [String: String] = [:]
        for row in selectorRows {
            let key = row.key.trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else { continue }
            selector[key] = row.value
        }
        // ClusterIP services can't carry a nodePort — strip it so the YAML is valid.
        let cleanedPorts: [Service.PortDraft] = portRows.map { row in
            guard type == Service.clusterIP else { return row }
            var r = row
            r.nodePort = ""
            return r
        }
        return Service.draft(
            name: name.trimmingCharacters(in: .whitespaces),
            namespace: namespace.trimmingCharacters(in: .whitespaces),
            type: type,
            selector: selector,
            ports: cleanedPorts
        )
    }
}
