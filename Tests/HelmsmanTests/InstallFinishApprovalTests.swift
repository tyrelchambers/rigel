import XCTest
@testable import Helmsman

final class InstallFinishApprovalTests: XCTestCase {
    private let scope = InstallScope(namespace: "personal", instance: "plane")

    private func action(_ json: String) -> SuggestedAction {
        try! JSONDecoder().decode(SuggestedAction.self, from: Data(json.utf8))
    }
    private func ok(_ json: String) -> Bool {
        InstallFinishApproval.autoApprovable(action(json), in: scope)
    }

    // MARK: - typed low-risk, in scope → auto

    func test_setEnv_onInstanceTarget_autoApproved() {
        XCTAssertTrue(ok(#"{"label":"x","kind":"setEnv","name":"plane-web","namespace":"personal","env":{"NEXT_PUBLIC_ADMIN_BASE_URL":"https://x"}}"#))
    }
    func test_restart_onInstanceItself_autoApproved() {
        XCTAssertTrue(ok(#"{"label":"x","kind":"restart","name":"plane","namespace":"personal"}"#))
    }
    func test_scaleUp_autoApproved() {
        XCTAssertTrue(ok(#"{"label":"x","kind":"scale","name":"plane-worker","namespace":"personal","replicas":1}"#))
    }

    // MARK: - scope failures → confirm

    func test_scaleToZero_requiresConfirm() {
        XCTAssertFalse(ok(#"{"label":"x","kind":"scale","name":"plane-web","namespace":"personal","replicas":0}"#))
    }
    func test_neighbourAppInSameNamespace_requiresConfirm() {
        // authentik in the shared `personal` namespace must never be auto-touched.
        XCTAssertFalse(ok(#"{"label":"x","kind":"setEnv","name":"authentik-server","namespace":"personal","env":{"X":"Y"}}"#))
    }
    func test_differentNamespace_requiresConfirm() {
        XCTAssertFalse(ok(#"{"label":"x","kind":"restart","name":"plane-web","namespace":"default"}"#))
    }
    func test_genericSharedResource_requiresConfirm() {
        // A generically-named bundled resource ("postgres") can't be proven to be
        // ours by name alone → confirm.
        XCTAssertFalse(ok(#"{"label":"x","kind":"restart","name":"postgres","namespace":"personal"}"#))
    }

    // MARK: - destructive / app-altering kinds → confirm

    func test_deleteWorkload_requiresConfirm() {
        XCTAssertFalse(ok(#"{"label":"x","kind":"deleteWorkload","name":"plane-web","namespace":"personal"}"#))
    }
    func test_setImage_requiresConfirm() {
        XCTAssertFalse(ok(#"{"label":"x","kind":"setImage","name":"plane-web","namespace":"personal","container":"c","image":"r:t"}"#))
    }
    func test_drain_requiresConfirm() {
        XCTAssertFalse(ok(#"{"label":"x","kind":"drain","node":"k3s-1"}"#))
    }

    // MARK: - generic command kind

    func test_command_annotateIngress_inScope_autoApproved() {
        XCTAssertTrue(ok(#"{"label":"x","kind":"command","args":["annotate","ingress","plane","-n","personal","cert-manager.io/cluster-issuer=letsencrypt-prod"]}"#))
    }
    func test_command_setEnv_deploymentRef_autoApproved() {
        XCTAssertTrue(ok(#"{"label":"x","kind":"command","args":["set","env","deployment/plane-web","-n","personal","NEXT_PUBLIC_ADMIN_BASE_URL=https://x"]}"#))
    }
    func test_command_deleteVerb_requiresConfirm() {
        XCTAssertFalse(ok(#"{"label":"x","kind":"command","args":["delete","pod","plane-web-abc","-n","personal"]}"#))
    }
    func test_command_missingNamespace_requiresConfirm() {
        XCTAssertFalse(ok(#"{"label":"x","kind":"command","args":["annotate","ingress","plane","cert-manager.io/cluster-issuer=letsencrypt-prod"]}"#))
    }
    func test_command_wrongNamespace_requiresConfirm() {
        XCTAssertFalse(ok(#"{"label":"x","kind":"command","args":["rollout","restart","deployment/plane-web","-n","default"]}"#))
    }
    func test_command_allNamespaces_requiresConfirm() {
        XCTAssertFalse(ok(#"{"label":"x","kind":"command","args":["get","pods","-A"]}"#))
    }
    func test_command_targetsNeighbour_requiresConfirm() {
        XCTAssertFalse(ok(#"{"label":"x","kind":"command","args":["annotate","ingress","authentik","-n","personal","foo=bar"]}"#))
    }
    func test_command_destructiveFlag_requiresConfirm() {
        XCTAssertFalse(ok(#"{"label":"x","kind":"command","args":["patch","deployment/plane-web","-n","personal","-p","{}"],"destructive":true}"#))
    }
    func test_command_unsafeVerb_requiresConfirm() {
        // 'apply' can create anything → not on the safe list.
        XCTAssertFalse(ok(#"{"label":"x","kind":"command","args":["apply","-f","-","-n","personal"]}"#))
    }
}
