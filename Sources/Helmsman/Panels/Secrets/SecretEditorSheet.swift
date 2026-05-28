import SwiftUI

enum SecretEditorMode: Identifiable {
    case create
    case edit(Secret)

    var id: String {
        switch self {
        case .create: return "__create__"
        case .edit(let s): return s.id
        }
    }
}

/// Create-or-edit form for a Secret. Submits an `.applySecret` action through
/// the normal WorkloadConfirmSheet flow — this sheet does not run kubectl
/// itself. On `.edit` the name + namespace + type are read-only.
struct SecretEditorSheet: View {
    let mode: SecretEditorMode
    let onSubmit: (Secret) -> Void
    let onCancel: () -> Void

    @State private var name: String = ""
    @State private var namespace: String = "default"
    @State private var type: SecretType = .opaque
    /// Decoded key/value rows. The view binds to this for every supported type;
    /// type-specific UIs read/write the same model under known keys.
    @State private var rows: [KVRow] = [KVRow(key: "", value: "")]
    // dockerconfigjson assembled from these four fields.
    @State private var dockerServer: String = ""
    @State private var dockerUsername: String = ""
    @State private var dockerPassword: String = ""
    @State private var dockerEmail: String = ""

    init(mode: SecretEditorMode, onSubmit: @escaping (Secret) -> Void, onCancel: @escaping () -> Void) {
        self.mode = mode
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        switch mode {
        case .create:
            _name = State(initialValue: "")
            _namespace = State(initialValue: "default")
            _type = State(initialValue: .opaque)
            _rows = State(initialValue: [KVRow(key: "", value: "")])
        case .edit(let s):
            _name = State(initialValue: s.metadata.name)
            _namespace = State(initialValue: s.metadata.namespace ?? "default")
            _type = State(initialValue: s.secretType)
            let pairs: [KVRow] = s.keysSorted.map { k in
                KVRow(key: k, value: s.decoded(k) ?? "")
            }
            _rows = State(initialValue: pairs.isEmpty ? [KVRow(key: "", value: "")] : pairs)

            // Parse dockerconfigjson into the four-field form if applicable.
            if s.secretType == .dockerconfigjson,
               let payload = s.decoded(".dockerconfigjson"),
               let parsed = Self.parseDockerConfigJSON(payload) {
                _dockerServer = State(initialValue: parsed.server)
                _dockerUsername = State(initialValue: parsed.username)
                _dockerPassword = State(initialValue: parsed.password)
                _dockerEmail = State(initialValue: parsed.email)
            }
        }
    }

    private struct DockerCreds {
        let server: String
        let username: String
        let password: String
        let email: String
    }

    /// Parse a dockerconfigjson payload (the JSON stored under `.dockerconfigjson`)
    /// back into the four-field UI form. Picks the first entry in `auths`.
    private static func parseDockerConfigJSON(_ s: String) -> DockerCreds? {
        guard let data = s.data(using: .utf8),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let auths = root["auths"] as? [String: Any],
              let first = auths.first else { return nil }
        let server = first.key
        let entry = (first.value as? [String: Any]) ?? [:]
        let username = entry["username"] as? String ?? ""
        let password = entry["password"] as? String ?? ""
        let email = entry["email"] as? String ?? ""
        return DockerCreds(server: server, username: username, password: password, email: email)
    }

    private var isEdit: Bool {
        if case .edit = mode { return true }
        return false
    }

    private var titleText: String {
        switch mode {
        case .create: return "Create secret"
        case .edit(let s): return "Edit \(s.metadata.name)"
        }
    }

    private var canSubmit: Bool {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty,
              !namespace.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        if type == .dockerconfigjson {
            return !dockerServer.trimmingCharacters(in: .whitespaces).isEmpty
                && !dockerUsername.trimmingCharacters(in: .whitespaces).isEmpty
                && !dockerPassword.isEmpty
        }
        // For typed secrets with canonical keys, require those keys to have values.
        let pinned = type.canonicalKeys
        if !pinned.isEmpty {
            return pinned.allSatisfy { k in
                rows.first(where: { $0.key == k })?.value.isEmpty == false
            }
        }
        // Opaque: need at least one non-empty key.
        return rows.contains { !$0.key.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    metadataBlock
                    typePicker
                    dataBlock
                }
                .padding(16)
            }
            .background(Theme.Surface.sunken)
            footer
        }
        .frame(width: 620, height: 620)
        .background(Theme.Surface.elevated)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg)
                .strokeBorder(Theme.Border.strong, lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "key.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Accent.primary)
            Text(titleText)
                .font(Theme.Font.body(14, weight: .semibold))
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

    private var metadataBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("METADATA")
            HStack(spacing: 10) {
                Label3(label: "NAME") {
                    TextField("my-secret", text: $name)
                        .textFieldStyle(.plain)
                        .font(Theme.Font.mono(12))
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(Theme.Surface.sunken)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                        .disabled(isEdit)
                }
                Label3(label: "NAMESPACE") {
                    TextField("default", text: $namespace)
                        .textFieldStyle(.plain)
                        .font(Theme.Font.mono(12))
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(Theme.Surface.sunken)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Radius.sm)
                                .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                        .disabled(isEdit)
                }
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

    private var typePicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("TYPE")
            if isEdit {
                HStack(spacing: 6) {
                    Text(type.displayName)
                        .font(Theme.Font.mono(12, weight: .medium))
                        .foregroundStyle(Theme.Accent.primary)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Theme.Accent.primaryDim)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    Text("(type can't be changed after creation)")
                        .font(Theme.Font.body(11))
                        .foregroundStyle(Theme.Foreground.tertiary)
                }
            } else {
                HStack(spacing: 6) {
                    ForEach(SecretType.allCases.filter { $0.isUserCreatable }, id: \.self) { t in
                        Button {
                            applyTypeChange(t)
                        } label: {
                            Text(t.displayName)
                                .font(Theme.Font.mono(11, weight: .medium))
                                .foregroundStyle(type == t ? Theme.Foreground.inverse : Theme.Foreground.secondary)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background(type == t ? Theme.Accent.primary : Theme.Surface.sunken)
                                .overlay(
                                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                                        .strokeBorder(type == t ? Color.clear : Theme.Border.strong, lineWidth: 1)
                                )
                                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                        }
                        .buttonStyle(.plain)
                    }
                }
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

    private var dataBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                sectionLabel(dataBlockTitle)
                Spacer()
                if type == .opaque {
                    Button {
                        rows.append(KVRow(key: "", value: ""))
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "plus").font(.system(size: 9, weight: .semibold))
                            Text("Add key").font(Theme.Font.body(11, weight: .medium))
                        }
                        .foregroundStyle(Theme.Accent.primary)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Theme.Accent.primaryDim)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    }
                    .buttonStyle(.plain)
                }
            }
            if type == .dockerconfigjson {
                dockerEditor
            } else {
                ForEach(rows.indices, id: \.self) { idx in
                    rowEditor(idx)
                }
            }
            if let hint = typeHint {
                Text(hint)
                    .font(Theme.Font.body(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
                    .padding(.top, 4)
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

    private var dockerEditor: some View {
        VStack(alignment: .leading, spacing: 10) {
            dockerField("REGISTRY SERVER", placeholder: "ghcr.io", text: $dockerServer)
            dockerField("USERNAME", placeholder: "user", text: $dockerUsername)
            dockerField("PASSWORD / TOKEN", placeholder: "•••", text: $dockerPassword, secure: true)
            dockerField("EMAIL (optional)", placeholder: "user@example.com", text: $dockerEmail)
        }
    }

    private func dockerField(_ label: String, placeholder: String, text: Binding<String>, secure: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(Theme.Font.body(10, weight: .semibold))
                .tracking(0.3)
                .foregroundStyle(Theme.Foreground.tertiary)
            Group {
                if secure {
                    SecureField(placeholder, text: text)
                } else {
                    TextField(placeholder, text: text)
                }
            }
            .textFieldStyle(.plain)
            .font(Theme.Font.mono(12))
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(Theme.Surface.sunken)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .strokeBorder(Theme.Border.subtle, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
        }
    }

    private var dataBlockTitle: String {
        switch type {
        case .dockerconfigjson:    return "DOCKER REGISTRY"
        case .tls:                 return "TLS CERTIFICATE"
        case .basicAuth:           return "BASIC AUTH"
        case .sshAuth:             return "SSH KEY"
        default:                   return "DATA"
        }
    }

    private var typeHint: String? {
        switch type {
        case .dockerconfigjson:
            return "Server, username, password are combined into the canonical .dockerconfigjson JSON payload on submit."
        case .tls:
            return "Paste the certificate and private key in PEM format. Both fields are required by Kubernetes."
        case .basicAuth:
            return "Standard kubernetes.io/basic-auth — fields are 'username' and 'password' on disk."
        case .sshAuth:
            return "PEM-encoded private key. Kubernetes stores it under the 'ssh-privatekey' key."
        default:
            return nil
        }
    }

    @ViewBuilder
    private func rowEditor(_ idx: Int) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 6) {
                TextField("key", text: Binding(
                    get: { rows[idx].key },
                    set: { rows[idx].key = $0 }
                ))
                .textFieldStyle(.plain)
                .font(Theme.Font.mono(12))
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                .disabled(type != .opaque)   // canonical-typed secrets pin the key

                TextField("value", text: Binding(
                    get: { rows[idx].value },
                    set: { rows[idx].value = $0 }
                ), axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .font(Theme.Font.mono(12))
                .padding(.horizontal, 8).padding(.vertical, 5)
                .background(Theme.Surface.sunken)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .strokeBorder(Theme.Border.subtle, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
            }
            if type == .opaque && rows.count > 1 {
                Button {
                    rows.remove(at: idx)
                } label: {
                    Image(systemName: "minus.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.Status.failed.opacity(0.7))
                        .padding(.top, 4)
                }
                .buttonStyle(.plain)
                .help("Remove this key")
            }
        }
        .padding(.vertical, 2)
        .id(rows[idx].id)
    }

    private func sectionLabel(_ s: String) -> some View {
        Text(s)
            .font(Theme.Font.body(11, weight: .semibold))
            .tracking(0.5)
            .foregroundStyle(Theme.Foreground.tertiary)
    }

    // MARK: - Type change handling

    /// Switching types in create-mode pre-fills the canonical keys.
    private func applyTypeChange(_ t: SecretType) {
        guard t != type else { return }
        type = t
        let keys = t.canonicalKeys
        if keys.isEmpty {
            rows = [KVRow(key: "", value: "")]
        } else {
            rows = keys.map { KVRow(key: $0, value: "") }
        }
    }

    // MARK: - Submit

    private var footer: some View {
        HStack(spacing: 10) {
            Spacer()
            Button(action: onCancel) {
                Text("Cancel")
                    .font(Theme.Font.body(12, weight: .medium))
                    .foregroundStyle(Theme.Foreground.secondary)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(Theme.Surface.sunken)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md)
                            .strokeBorder(Theme.Border.strong, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)

            Button {
                onSubmit(buildSecret())
            } label: {
                Text(isEdit ? "Apply" : "Create")
                    .font(Theme.Font.body(12, weight: .semibold))
                    .foregroundStyle(Theme.Foreground.inverse)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(canSubmit ? Theme.Accent.primary : Theme.Foreground.tertiary)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
                    .opacity(canSubmit ? 1.0 : 0.4)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.defaultAction)
            .disabled(!canSubmit)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(Theme.Surface.primary)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.Border.subtle).frame(height: 1)
        }
    }

    private func buildSecret() -> Secret {
        var decoded: [String: String] = [:]
        if type == .dockerconfigjson {
            decoded[".dockerconfigjson"] = dockerConfigJSONPayload()
        } else {
            let cleanRows = rows
                .map { (k: $0.key.trimmingCharacters(in: .whitespacesAndNewlines), v: $0.value) }
                .filter { !$0.k.isEmpty }
            for r in cleanRows { decoded[r.k] = r.v }
        }
        return Secret.draft(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            namespace: namespace.trimmingCharacters(in: .whitespacesAndNewlines),
            type: type,
            decodedData: decoded
        )
    }

    /// Build the canonical dockerconfigjson body kubelet expects on disk.
    /// `auth` is base64("username:password"), which is what Docker and
    /// containerd both consult.
    private func dockerConfigJSONPayload() -> String {
        let server = dockerServer.trimmingCharacters(in: .whitespacesAndNewlines)
        let user = dockerUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        let pass = dockerPassword
        let email = dockerEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        let authBlob = Data("\(user):\(pass)".utf8).base64EncodedString()

        var entry: [String: Any] = [
            "username": user,
            "password": pass,
            "auth": authBlob,
        ]
        if !email.isEmpty { entry["email"] = email }
        let root: [String: Any] = ["auths": [server: entry]]
        guard let data = try? JSONSerialization.data(withJSONObject: root, options: [.sortedKeys]),
              let str = String(data: data, encoding: .utf8) else { return "{}" }
        return str
    }
}

struct KVRow: Identifiable, Hashable {
    let id = UUID()
    var key: String
    var value: String
}

/// Small inline "LABEL: control" row. Mirrors `Label2` in WorkloadConfirmSheet
/// but stays in this file (file-private) so the two stay independent.
private struct Label3<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(Theme.Font.body(10, weight: .semibold))
                .tracking(0.3)
                .foregroundStyle(Theme.Foreground.tertiary)
            content
        }
    }
}
