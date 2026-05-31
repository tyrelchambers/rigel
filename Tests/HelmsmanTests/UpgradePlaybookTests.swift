import XCTest
@testable import Helmsman

final class UpgradePlaybookTests: XCTestCase {

    func test_text_loadsFromBundleWithPhaseAnchors() {
        guard let text = UpgradePlaybook.text else {
            return XCTFail("expected the playbook to load from the bundle")
        }
        XCTAssertTrue(text.contains("Phase 0"), "missing Phase 0 anchor")
        XCTAssertTrue(text.contains("Phase 4"), "missing Phase 4 anchor")
        XCTAssertTrue(text.contains("setImage"), "playbook should reference the setImage apply step")
    }

    func test_upgradeMessage_prependsPlaybookToContextBlock() {
        let plan = UpgradePlan(
            appName: "Plausible", currentTag: "v2.1.4", targetTag: "v3.2.1",
            targets: [ImageUpgradeTarget(
                workloadKind: "deployment", workloadName: "plausible", namespace: "default",
                container: "app", currentImage: "ghcr.io/plausible/community-edition:v2.1.4",
                newImage: "ghcr.io/plausible/community-edition:v3.2.1"
            )]
        )
        let (text, missing) = UpgradePlaybook.upgradeMessage(for: plan)
        XCTAssertFalse(missing)
        // Playbook guidance comes first, the concrete request after it.
        let playbookIdx = text.range(of: "Phase 0")
        let requestIdx = text.range(of: "UPGRADE REQUEST")
        XCTAssertNotNil(playbookIdx)
        XCTAssertNotNil(requestIdx)
        XCTAssertTrue(playbookIdx!.lowerBound < requestIdx!.lowerBound, "playbook should precede the request")
        XCTAssertTrue(text.contains("v3.2.1"))
    }
}
