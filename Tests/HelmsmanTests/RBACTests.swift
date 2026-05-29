import XCTest
@testable import Helmsman

final class RBACTests: XCTestCase {

    func test_serviceAccount_secretCount() throws {
        let sa = try JSONDecoder.kube.decode(ServiceAccount.self, from: Data("""
        {"metadata":{"name":"builder","namespace":"default","uid":"s1"},"secrets":[{"name":"t1"},{"name":"t2"}]}
        """.utf8))
        XCTAssertEqual(sa.secretCount, 2)
    }

    func test_role_ruleCount() throws {
        let role = try JSONDecoder.kube.decode(Role.self, from: Data("""
        {"metadata":{"name":"reader","namespace":"default","uid":"r1"},
         "rules":[{"apiGroups":[""],"resources":["pods"],"verbs":["get","list"]}]}
        """.utf8))
        XCTAssertEqual(role.ruleCount, 1)
    }

    func test_roleBinding_roleRefAndSubjects() throws {
        let rb = try JSONDecoder.kube.decode(RoleBinding.self, from: Data("""
        {"metadata":{"name":"bind","namespace":"default","uid":"rb1"},
         "roleRef":{"kind":"Role","name":"reader"},
         "subjects":[{"kind":"ServiceAccount","name":"builder","namespace":"default"}]}
        """.utf8))
        XCTAssertEqual(rb.roleRef?.label, "Role/reader")
        XCTAssertEqual(rb.subjectCount, 1)
        XCTAssertEqual(RBACDisplay.subjectsSummary(rb.subjects), "sa:default/builder")
    }

    func test_subjectsSummary_truncatesAndAbbreviates() {
        let subjects = [
            Subject(kind: "ServiceAccount", name: "a", namespace: "ns"),
            Subject(kind: "User", name: "alice", namespace: nil),
            Subject(kind: "Group", name: "devs", namespace: nil),
            Subject(kind: "User", name: "bob", namespace: nil),
        ]
        let summary = RBACDisplay.subjectsSummary(subjects)
        XCTAssertTrue(summary.contains("sa:ns/a"))
        XCTAssertTrue(summary.contains("user:alice"))
        XCTAssertTrue(summary.contains("+1"))   // 4 subjects, 3 shown
    }

    // MARK: - WorkloadAction (delete)

    func test_deleteRBAC_namespaced() {
        let action = WorkloadAction.deleteRBAC(kind: "rolebinding", name: "bind", namespace: "default")
        XCTAssertEqual(action.kubectlInvocations(), [.args(["delete", "rolebinding", "bind", "-n", "default"])])
        XCTAssertTrue(action.isHighRisk)
        XCTAssertTrue(action.needsAcknowledge)
    }

    func test_deleteRBAC_clusterScopedOmitsNamespace() {
        let action = WorkloadAction.deleteRBAC(kind: "clusterrole", name: "admin", namespace: nil)
        XCTAssertEqual(action.kubectlInvocations(), [.args(["delete", "clusterrole", "admin"])])
        XCTAssertTrue(action.isHighRisk)
    }
}
