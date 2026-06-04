import SwiftUI

struct AccountsPanel: View {
    @Bindable var viewModel: AccountsViewModel
    @State private var addingAccount = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        PanelTitle(.accounts)
                        Text("Credentials Helmsman uses to pull images for catalog installs. Stored as a standard Kubernetes Secret (base64 in etcd) — not encrypted at rest.")
                            .font(Theme.Font.body(11))
                            .foregroundStyle(Theme.Foreground.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Button { addingAccount = true } label: {
                        Label("Add account", systemImage: "plus")
                            .font(Theme.Font.body(12, weight: .semibold))
                    }
                    .buttonStyle(.borderedProminent)
                }

                if viewModel.accounts.isEmpty {
                    Text("No accounts yet. Add a Docker Hub (or ghcr/quay) account so installs pull authenticated and avoid rate limits.")
                        .font(Theme.Font.body(12))
                        .foregroundStyle(Theme.Foreground.tertiary)
                        .padding(.vertical, 8)
                } else {
                    VStack(spacing: 8) {
                        ForEach(viewModel.accounts) { account in
                            AccountRow(account: account,
                                       onSetDefault: { viewModel.setDefault(account.id) },
                                       onDelete: { viewModel.delete(account.id) })
                        }
                    }
                }
            }
            .padding(20)
            .frame(maxWidth: 720, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.Surface.primary)
        .sheet(isPresented: $addingAccount) {
            AddAccountSheet(viewModel: viewModel, onClose: { addingAccount = false })
        }
    }
}

private struct AccountRow: View {
    let account: RegistryAccount
    let onSetDefault: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "shippingbox.fill")
                .foregroundStyle(Theme.Accent.primary)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(account.registry)
                        .font(Theme.Font.mono(12, weight: .semibold))
                        .foregroundStyle(Theme.Foreground.primary)
                    if account.isDefault {
                        Text("default")
                            .font(Theme.Font.mono(9, weight: .semibold))
                            .foregroundStyle(Theme.Accent.primary)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Theme.Accent.primaryDim)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    }
                    if !account.managed {
                        Text("referenced")
                            .font(Theme.Font.mono(9))
                            .foregroundStyle(Theme.Foreground.tertiary)
                    }
                }
                Text("\(account.username.isEmpty ? "" : "\(account.username) · ")secret/\(account.secretName) in \(account.sourceNamespace)")
                    .font(Theme.Font.mono(10))
                    .foregroundStyle(Theme.Foreground.secondary)
            }
            Spacer()
            if !account.isDefault {
                Button("Set default", action: onSetDefault)
                    .font(Theme.Font.body(11))
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.Accent.primary)
            }
            Button(role: .destructive, action: onDelete) {
                Image(systemName: "trash").foregroundStyle(Theme.Status.failed)
            }
            .buttonStyle(.plain)
            .help("Remove account (does not delete the cluster Secret)")
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Surface.elevated)
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
    }
}

private struct AddAccountSheet: View {
    @Bindable var viewModel: AccountsViewModel
    let onClose: () -> Void

    @State private var mode: Mode = .create
    @State private var registry = "docker.io"
    @State private var username = ""
    @State private var token = ""
    @State private var secretName = "helmsman-dockerhub"
    @State private var namespace = "default"
    @State private var makeDefault = true

    private enum Mode: String, CaseIterable { case create = "Create", reference = "Reference existing" }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Add registry account")
                .font(Theme.Font.body(15, weight: .semibold))
                .foregroundStyle(Theme.Foreground.primary)

            Picker("", selection: $mode) {
                ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            field("Registry") { TextField("docker.io", text: $registry) }
            field("Username") { TextField("dockerhub user", text: $username) }
            if mode == .create {
                field("Access token") { SecureField("personal access token", text: $token) }
            }
            field("Secret name") { TextField("helmsman-dockerhub", text: $secretName) }
            field("Namespace") { TextField("default", text: $namespace) }
            Toggle("Use as the default for installs", isOn: $makeDefault)
                .font(Theme.Font.body(12))

            if let err = viewModel.errorMessage {
                Text(err).font(Theme.Font.mono(10)).foregroundStyle(Theme.Status.failed)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer()
                Button("Cancel", action: onClose).buttonStyle(.plain)
                Button(viewModel.busy ? "Working…" : "Add") { Task { await submit() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(viewModel.busy || !canSubmit)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { viewModel.errorMessage = nil }
    }

    private var canSubmit: Bool {
        guard !registry.trimmingCharacters(in: .whitespaces).isEmpty,
              !secretName.trimmingCharacters(in: .whitespaces).isEmpty,
              !namespace.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        return mode == .reference || !token.isEmpty
    }

    private func submit() async {
        if mode == .create {
            await viewModel.addManaged(registry: registry, username: username, token: token,
                                       secretName: secretName, namespace: namespace, makeDefault: makeDefault)
        } else {
            await viewModel.addReference(registry: registry, username: username,
                                         secretName: secretName, namespace: namespace, makeDefault: makeDefault)
        }
        if viewModel.errorMessage == nil { onClose() }
    }

    private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(Theme.Font.mono(9, weight: .semibold))
                .foregroundStyle(Theme.Foreground.tertiary)
            content()
                .textFieldStyle(.plain)
                .font(Theme.Font.mono(12))
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(Theme.Surface.field)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm).strokeBorder(Theme.Border.subtle, lineWidth: 1))
        }
    }
}
