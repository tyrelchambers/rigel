import XCTest
@testable import Helmsman

final class WorkloadActionCNPGTests: XCTestCase {
    func test_backupNow_invocationAndRisk() {
        let a = WorkloadAction.cnpgBackupNow(cluster: "pg", namespace: "default")
        XCTAssertEqual(a.kubectlInvocations(), [.args(["cnpg", "backup", "pg", "-n", "default"])])
        XCTAssertFalse(a.isHighRisk)
        XCTAssertFalse(a.needsAcknowledge)
    }

    func test_switchover_promotesInstance_highRisk() {
        let a = WorkloadAction.cnpgSwitchover(cluster: "pg", namespace: "default", to: "pg-2")
        XCTAssertEqual(a.kubectlInvocations(), [.args(["cnpg", "promote", "pg", "pg-2", "-n", "default"])])
        XCTAssertTrue(a.isHighRisk)
        XCTAssertFalse(a.needsAcknowledge)
    }

    func test_hibernateOn_requiresAcknowledge() {
        let a = WorkloadAction.cnpgHibernate(cluster: "pg", namespace: "default", on: true)
        XCTAssertEqual(a.kubectlInvocations(), [.args(["cnpg", "hibernate", "on", "pg", "-n", "default"])])
        XCTAssertTrue(a.isHighRisk)
        XCTAssertTrue(a.needsAcknowledge)
    }

    func test_hibernateOff_isLowRisk() {
        let a = WorkloadAction.cnpgHibernate(cluster: "pg", namespace: "default", on: false)
        XCTAssertEqual(a.kubectlInvocations(), [.args(["cnpg", "hibernate", "off", "pg", "-n", "default"])])
        XCTAssertFalse(a.isHighRisk)
        XCTAssertFalse(a.needsAcknowledge)
    }

    func test_scaleCNPG_patchesInstances() {
        let a = WorkloadAction.scaleCNPG(cluster: "pg", namespace: "default", current: 3, to: 5)
        XCTAssertEqual(a.kubectlInvocations(), [.args(["patch", "cluster", "pg", "-n", "default", "--type=merge", "-p", "{\"spec\":{\"instances\":5}}"])])
        XCTAssertFalse(a.isHighRisk)
        XCTAssertFalse(a.needsAcknowledge)
    }

    func test_scaleCNPG_down_requiresAcknowledge() {
        let a = WorkloadAction.scaleCNPG(cluster: "pg", namespace: "default", current: 3, to: 1)
        XCTAssertTrue(a.isHighRisk)
        XCTAssertTrue(a.needsAcknowledge)
    }

    func test_command_runsLiteralArgs_titleIsLabel() {
        let a = WorkloadAction.command(args: ["cnpg", "destroy", "pg", "pg-1", "-n", "default"], label: "Destroy pg-1", destructive: true)
        XCTAssertEqual(a.kubectlInvocations(), [.args(["cnpg", "destroy", "pg", "pg-1", "-n", "default"])])
        XCTAssertEqual(a.title, "Destroy pg-1")
    }

    func test_destructiveCommand_isHighRiskAndNeedsAcknowledge() {
        let a = WorkloadAction.command(args: ["delete", "ns", "x"], label: "Delete ns x", destructive: true)
        XCTAssertTrue(a.isHighRisk)
        XCTAssertTrue(a.needsAcknowledge)
    }

    func test_nonDestructiveCommand_isNeutral() {
        let a = WorkloadAction.command(args: ["rollout", "restart", "deploy/x", "-n", "default"], label: "Restart x", destructive: false)
        XCTAssertFalse(a.isHighRisk)
        XCTAssertFalse(a.needsAcknowledge)
    }
}
