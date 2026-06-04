import XCTest
@testable import Helmsman

@MainActor
final class RegistryAccountTests: XCTestCase {
    func test_registryAccount_codableRoundTrips() throws {
        let a = RegistryAccount(id: UUID(), registry: "docker.io", username: "tyrel",
                                secretName: "helmsman-dockerhub", sourceNamespace: "default",
                                managed: true, isDefault: true)
        let data = try JSONEncoder().encode(a)
        let back = try JSONDecoder().decode(RegistryAccount.self, from: data)
        XCTAssertEqual(back, a)

        let c = RegistryAccount(id: UUID(), registry: "ghcr.io", username: "x",
                                secretName: "s", sourceNamespace: "media",
                                managed: false, isDefault: false)
        XCTAssertEqual(try JSONDecoder().decode(RegistryAccount.self, from: JSONEncoder().encode(c)), c)
    }

    func test_defaultRegistryAccount_returnsTheFlaggedOne() {
        let store = SessionStore.shared
        let ctx = "test-ctx-\(UUID().uuidString)"
        let a = RegistryAccount(id: UUID(), registry: "docker.io", username: "u",
                                secretName: "s", sourceNamespace: "default",
                                managed: true, isDefault: false)
        let b = RegistryAccount(id: UUID(), registry: "ghcr.io", username: "u",
                                secretName: "s2", sourceNamespace: "default",
                                managed: true, isDefault: true)
        store.setRegistryAccounts([a, b], for: ctx)
        XCTAssertEqual(store.defaultRegistryAccount(for: ctx)?.id, b.id)
        XCTAssertEqual(store.registryAccounts(for: ctx).count, 2)
        store.setRegistryAccounts([], for: ctx)   // cleanup
        XCTAssertNil(store.defaultRegistryAccount(for: ctx))
    }

    func test_accountsViewModel_setDefault_makesExactlyOneDefault() {
        let ctx = "vm-ctx-\(UUID().uuidString)"
        let vm = AccountsViewModel(context: ctx)
        let a = RegistryAccount(id: UUID(), registry: "docker.io", username: "u", secretName: "s",
                                sourceNamespace: "default", managed: false, isDefault: true)
        let b = RegistryAccount(id: UUID(), registry: "ghcr.io", username: "u", secretName: "s2",
                                sourceNamespace: "default", managed: false, isDefault: false)
        vm.accounts = [a, b]
        vm.persist()
        vm.setDefault(b.id)
        XCTAssertEqual(vm.accounts.filter(\.isDefault).map(\.id), [b.id])
        XCTAssertEqual(SessionStore.shared.defaultRegistryAccount(for: ctx)?.id, b.id)
        SessionStore.shared.setRegistryAccounts([], for: ctx)   // cleanup
    }
}
