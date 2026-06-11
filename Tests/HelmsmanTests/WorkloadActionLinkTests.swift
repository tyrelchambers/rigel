import XCTest
@testable import Helmsman

/// Command-builder parity tests for the catalog link/unlink actions. The exact
/// argv MUST match the web server's `buildCommand` (`apps/server/src/actions.ts`)
/// and `docs/parity/catalog-link-workload.md` §6. `--context` is NEVER in the
/// builder output — the commander prepends it.
final class WorkloadActionLinkTests: XCTestCase {

    func test_link_daemonset_noContainer() {
        let a = WorkloadAction.linkCatalogApp(
            kind: "daemonset", name: "node-exp", namespace: "mon", appID: "node-exporter", container: nil
        )
        XCTAssertEqual(a.kubectlInvocations(), [.args([
            "annotate", "daemonset/node-exp",
            "helmsman.dev/catalog-app=node-exporter",
            "-n", "mon", "--overwrite",
        ])])
        XCTAssertFalse(a.isHighRisk)
        XCTAssertFalse(a.needsAcknowledge)
    }

    func test_link_withContainer_setsBothKeysInOneInvocation() {
        let a = WorkloadAction.linkCatalogApp(
            kind: "deployment", name: "web", namespace: "default", appID: "ghost", container: "ghost"
        )
        XCTAssertEqual(a.kubectlInvocations(), [.args([
            "annotate", "deployment/web",
            "helmsman.dev/catalog-app=ghost",
            "helmsman.dev/catalog-container=ghost",
            "-n", "default", "--overwrite",
        ])])
    }

    func test_unlink_statefulset_removesBothKeys() {
        let a = WorkloadAction.unlinkCatalogApp(kind: "statefulset", name: "db", namespace: "default")
        XCTAssertEqual(a.kubectlInvocations(), [.args([
            "annotate", "statefulset/db",
            "helmsman.dev/catalog-app-",
            "helmsman.dev/catalog-container-",
            "-n", "default",
        ])])
        XCTAssertFalse(a.isHighRisk)
        XCTAssertFalse(a.needsAcknowledge)
    }

    func test_link_previewCarriesNoContext() {
        let a = WorkloadAction.linkCatalogApp(
            kind: "deployment", name: "web", namespace: "default", appID: "ghost", container: nil
        )
        let preview = a.previewCommand(context: "prod")
        // The runner prepends --context; the BUILDER (kubectlInvocations) must not.
        XCTAssertFalse(a.kubectlInvocations().first!.args.contains("--context"))
        XCTAssertTrue(preview.contains("kubectl --context prod annotate deployment/web"))
    }
}
