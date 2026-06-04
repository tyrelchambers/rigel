import Foundation
import Observation

@MainActor
@Observable
final class AccountsViewModel {
    private(set) var context: String?
    var accounts: [RegistryAccount] = []
    /// Non-nil while an add/verify is running; drives a spinner + disables the form.
    var busy = false
    var errorMessage: String?

    init(context: String?) {
        self.context = context
        self.accounts = SessionStore.shared.registryAccounts(for: context ?? "")
    }

    func load(context: String?) {
        self.context = context
        self.accounts = SessionStore.shared.registryAccounts(for: context ?? "")
        errorMessage = nil
    }

    func persist() {
        SessionStore.shared.setRegistryAccounts(accounts, for: context ?? "")
    }

    /// Flip the default flag so exactly the given account is default (others off).
    func setDefault(_ id: UUID) {
        accounts = accounts.map { var a = $0; a.isDefault = (a.id == id); return a }
        persist()
    }

    func delete(_ id: UUID) {
        accounts.removeAll { $0.id == id }
        persist()
    }

    /// Create path: build + apply the Secret, then record metadata. Token is not
    /// retained. `makeDefault` marks this the context default on success.
    func addManaged(registry: String, username: String, token: String,
                    secretName: String, namespace: String, makeDefault: Bool) async {
        busy = true; errorMessage = nil
        defer { busy = false }
        let outcome = await RegistryAccountReconciler(context: context).create(
            registry: registry, username: username, token: token,
            secretName: secretName, namespace: namespace)
        guard case .ok = outcome else {
            if case let .failed(msg) = outcome { errorMessage = msg }
            return
        }
        var account = RegistryAccount(id: UUID(), registry: registry, username: username,
                                      secretName: secretName, sourceNamespace: namespace,
                                      managed: true, isDefault: false)
        if makeDefault || accounts.isEmpty { account.isDefault = true }
        appendEnforcingSingleDefault(account)
    }

    /// Reference path: verify the existing Secret, then record metadata only.
    func addReference(registry: String, username: String, secretName: String,
                      namespace: String, makeDefault: Bool) async {
        busy = true; errorMessage = nil
        defer { busy = false }
        let outcome = await RegistryAccountReconciler(context: context).verifyReference(
            secretName: secretName, namespace: namespace)
        guard case .ok = outcome else {
            if case let .failed(msg) = outcome { errorMessage = msg }
            return
        }
        var account = RegistryAccount(id: UUID(), registry: registry, username: username,
                                      secretName: secretName, sourceNamespace: namespace,
                                      managed: false, isDefault: false)
        if makeDefault || accounts.isEmpty { account.isDefault = true }
        appendEnforcingSingleDefault(account)
    }

    private func appendEnforcingSingleDefault(_ account: RegistryAccount) {
        if account.isDefault { accounts = accounts.map { var a = $0; a.isDefault = false; return a } }
        accounts.append(account)
        persist()
    }
}
