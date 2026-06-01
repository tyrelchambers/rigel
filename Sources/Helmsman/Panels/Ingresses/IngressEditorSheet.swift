import SwiftUI

enum IngressEditorMode: Identifiable {
    case create
    case edit(Ingress)

    var id: String {
        switch self {
        case .create: return "__create__"
        case .edit(let i): return i.id
        }
    }

    var isNew: Bool { if case .create = self { return true } else { return false } }
}

/// Create-or-edit form for an Ingress. Builds an `Ingress` value and hands it
/// back via `onSubmit` — the caller submits `.applyIngress` through the normal
/// WorkloadConfirmSheet flow. This sheet runs no mutating kubectl commands; the
/// only kubectl call is a read-only `get clusterissuers` to populate the
/// cert-manager dropdown. On `.edit`, name + namespace are read-only.
struct IngressEditorSheet: View {
    let mode: IngressEditorMode
    let context: String?
    let onSubmit: (_ ingress: Ingress, _ isNew: Bool) -> Void
    let onCancel: () -> Void

    @State private var name: String
    @State private var namespace: String
    @State private var className: String
    @State private var ruleRows: [Ingress.RuleDraft]
    @State private var tlsRows: [Ingress.TLSDraft]
    @State private var annotationRows: [KVRow]

    // cert-manager
    @State private var certManagerEnabled: Bool
    @State private var issuers: [String] = []
    @State private var selectedIssuer: String = ""
    @State private var isLoadingIssuers = true
    @State private var issuerError: String? = nil

    private let pathTypes = ["Prefix", "Exact", "ImplementationSpecific"]

    /// The form has no defaultBackend field, but the manage sheet shows it as a
    /// route — carry it through unchanged so an edit-then-apply doesn't drop it.
    private let originalDefaultBackend: Ingress.Backend?

    init(
        mode: IngressEditorMode,
        context: String?,
        onSubmit: @escaping (_ ingress: Ingress, _ isNew: Bool) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.mode = mode
        self.context = context
        self.onSubmit = onSubmit
        self.onCancel = onCancel
        switch mode {
        case .create:
            _name = State(initialValue: "")
            _namespace = State(initialValue: "default")
            _className = State(initialValue: "")
            _ruleRows = State(initialValue: [Ingress.RuleDraft(host: "", path: "/", pathType: "Prefix", service: "", port: "80")])
            _tlsRows = State(initialValue: [])
            _annotationRows = State(initialValue: [])
            _certManagerEnabled = State(initialValue: false)
            originalDefaultBackend = nil
        case .edit(let ing):
            _name = State(initialValue: ing.metadata.name)
            _namespace = State(initialValue: ing.metadata.namespace ?? "default")
            _className = State(initialValue: ing.spec?.ingressClassName ?? "")
            let rules = ing.ruleDrafts
            _ruleRows = State(initialValue: rules.isEmpty ? [Ingress.RuleDraft(host: "", path: "/", pathType: "Prefix", service: "", port: "80")] : rules)
            _tlsRows = State(initialValue: ing.tlsDrafts)
            let annotations = ing.editableAnnotations
            _annotationRows = State(initialValue: annotations.sorted { $0.key < $1.key }.map { KVRow(key: $0.key, value: $0.value) })
            let existingIssuer = annotations[Ingress.certManagerIssuerAnnotation]
            _certManagerEnabled = State(initialValue: existingIssuer != nil)
            _selectedIssuer = State(initialValue: existingIssuer ?? "")
            originalDefaultBackend = ing.spec?.defaultBackend
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().background(Theme.Border.subtle)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    identityBlock
                    rulesBlock
                    tlsBlock
                    certManagerBlock
                    annotationsBlock
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
        .task { await loadClusterIssuers() }
    }

    // MARK: - Header / footer

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "signpost.right.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Accent.primary)
            Text(mode.isNew ? "New Ingress" : "Edit \(name)")
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

    private var canSubmit: Bool {
        let serviceRows = ruleRows.filter { !$0.service.trimmingCharacters(in: .whitespaces).isEmpty }
        return !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !serviceRows.isEmpty
            // A service backend must have a port — don't let a rule submit without one.
            && serviceRows.allSatisfy { !$0.port.trimmingCharacters(in: .whitespaces).isEmpty }
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
                onSubmit(buildIngress(), mode.isNew)
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

    // MARK: - Sections

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
                field("ingressClassName (e.g. nginx)", text: $className)
            }
        }
    }

    private var rulesBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                sectionTitle("ROUTING RULES")
                Spacer()
                addButton { ruleRows.append(Ingress.RuleDraft(host: "", path: "/", pathType: "Prefix", service: "", port: "80")) }
            }
            ForEach(ruleRows.indices, id: \.self) { i in
                HStack(spacing: 6) {
                    field("host", text: $ruleRows[i].host)
                    field("path", text: $ruleRows[i].path)
                    Picker("", selection: $ruleRows[i].pathType) {
                        ForEach(pathTypes, id: \.self) { Text($0).font(Theme.Font.mono(11)) }
                    }
                    .labelsHidden()
                    .frame(width: 150)
                    field("service", text: $ruleRows[i].service)
                    field("port", text: $ruleRows[i].port).frame(width: 70)
                    removeButton { ruleRows.remove(at: i) }
                }
            }
        }
    }

    private var tlsBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                sectionTitle("TLS")
                Spacer()
                addButton { tlsRows.append(Ingress.TLSDraft(host: "", secretName: "")) }
            }
            if tlsRows.isEmpty {
                Text("No TLS entries. Add one manually, or enable cert-manager below.")
                    .font(Theme.Font.mono(11))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
            ForEach(tlsRows.indices, id: \.self) { i in
                HStack(spacing: 6) {
                    field("host", text: $tlsRows[i].host)
                    field("secretName", text: $tlsRows[i].secretName)
                    removeButton { tlsRows.remove(at: i) }
                }
            }
        }
    }

    private var certManagerBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("CERT-MANAGER (AUTOMATIC HTTPS)")
            HStack(spacing: 10) {
                Toggle(isOn: $certManagerEnabled) {
                    Text("Enable HTTPS via cert-manager")
                        .font(Theme.Font.body(12))
                        .foregroundStyle(Theme.Foreground.primary)
                }
                .toggleStyle(.switch)
                .disabled(isLoadingIssuers || (issuers.isEmpty && issuerError != nil))
                Spacer()
                if isLoadingIssuers {
                    ProgressView().controlSize(.mini).tint(Theme.Accent.primary)
                } else if !issuers.isEmpty {
                    Picker("", selection: $selectedIssuer) {
                        ForEach(issuers, id: \.self) { Text($0).font(Theme.Font.mono(11)) }
                    }
                    .labelsHidden()
                    .frame(width: 220)
                    .disabled(!certManagerEnabled)
                }
            }
            if let issuerError {
                Text(issuerError)
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            } else if certManagerEnabled {
                Text("Adds `\(Ingress.certManagerIssuerAnnotation): \(selectedIssuer)` and a TLS entry (secret `\(certSecretName)`) covering your rule hosts.")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.tertiary)
            }
        }
        .padding(10)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }

    private var annotationsBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                sectionTitle("ANNOTATIONS")
                Spacer()
                addButton { annotationRows.append(KVRow(key: "", value: "")) }
            }
            ForEach(annotationRows.indices, id: \.self) { i in
                HStack(spacing: 6) {
                    field("key", text: $annotationRows[i].key)
                    field("value", text: $annotationRows[i].value)
                    removeButton { annotationRows.remove(at: i) }
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

    // MARK: - Build

    private var certSecretName: String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        return "\(trimmed.isEmpty ? "ingress" : trimmed)-tls"
    }

    private func buildIngress() -> Ingress {
        var annotations: [String: String] = [:]
        for row in annotationRows {
            let key = row.key.trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else { continue }
            annotations[key] = row.value
        }
        var tls = tlsRows

        if certManagerEnabled && !selectedIssuer.isEmpty {
            annotations[Ingress.certManagerIssuerAnnotation] = selectedIssuer
            let hosts = Array(Set(ruleRows.map(\.host).filter { !$0.isEmpty })).sorted()
            let secret = certSecretName
            if !tls.contains(where: { $0.secretName == secret }) {
                if hosts.isEmpty {
                    tls.append(Ingress.TLSDraft(host: "", secretName: secret))
                } else {
                    tls.append(contentsOf: hosts.map { Ingress.TLSDraft(host: $0, secretName: secret) })
                }
            }
        } else {
            annotations.removeValue(forKey: Ingress.certManagerIssuerAnnotation)
        }

        return Ingress.draft(
            name: name.trimmingCharacters(in: .whitespaces),
            namespace: namespace.trimmingCharacters(in: .whitespaces),
            className: className.trimmingCharacters(in: .whitespaces),
            rules: ruleRows,
            tls: tls,
            annotations: annotations,
            defaultBackend: originalDefaultBackend
        )
    }

    // MARK: - ClusterIssuer detection (read-only)

    private func loadClusterIssuers() async {
        do {
            let names = try await ClusterIssuerLoader.load(context: context)
            await MainActor.run {
                issuers = names
                isLoadingIssuers = false
                if selectedIssuer.isEmpty, let first = names.first { selectedIssuer = first }
                if names.isEmpty { issuerError = "No ClusterIssuers found." }
            }
        } catch ClusterIssuerLoader.LoadError.kubectlNotFound {
            await MainActor.run { issuerError = "kubectl not found"; isLoadingIssuers = false }
        } catch {
            await MainActor.run {
                issuerError = "cert-manager not detected (no ClusterIssuers)."
                isLoadingIssuers = false
            }
        }
    }
}
