import XCTest
@testable import Helmsman

final class NavCollapseStateTests: XCTestCase {

    func test_toggle_addsTitleWhenAbsent_removesWhenPresent() {
        var state = NavCollapseState(storage: "")
        XCTAssertFalse(state.isCollapsed("Workloads"))

        state.toggle("Workloads")
        XCTAssertTrue(state.isCollapsed("Workloads"))

        state.toggle("Workloads")
        XCTAssertFalse(state.isCollapsed("Workloads"))
    }

    func test_reveal_expandsTheGroupContainingThePanel() {
        var state = NavCollapseState(storage: "Networking")
        XCTAssertTrue(state.isCollapsed("Networking"))

        // .services lives in the "Networking" group.
        state.reveal(panel: .services)
        XCTAssertFalse(state.isCollapsed("Networking"))
    }

    func test_reveal_leavesOtherCollapsedGroupsUntouched() {
        var state = NavCollapseState(storage: "Networking,Cluster")
        state.reveal(panel: .services)   // Networking group
        XCTAssertFalse(state.isCollapsed("Networking"))
        XCTAssertTrue(state.isCollapsed("Cluster"))
    }

    func test_reveal_pinnedPanel_isNoOp() {
        // .overview is in the pinned (title-less) group, so it can't be collapsed.
        var state = NavCollapseState(storage: "Workloads")
        state.reveal(panel: .overview)
        XCTAssertTrue(state.isCollapsed("Workloads"))
    }

    func test_storage_roundTripsTheSet() {
        var state = NavCollapseState(storage: "")
        state.toggle("Workloads")
        state.toggle("Cluster")

        let reloaded = NavCollapseState(storage: state.storage)
        XCTAssertTrue(reloaded.isCollapsed("Workloads"))
        XCTAssertTrue(reloaded.isCollapsed("Cluster"))
    }

    func test_initStorage_emptyStringIsEmptySet() {
        let state = NavCollapseState(storage: "")
        XCTAssertTrue(state.collapsed.isEmpty)
    }

    func test_initStorage_dropsBlankEntries() {
        let state = NavCollapseState(storage: "Workloads,, ,Cluster")
        XCTAssertEqual(state.collapsed, ["Workloads", "Cluster"])
    }

    func test_collapsedByDefault_collapsesEveryTitledGroup() {
        let state = NavCollapseState.collapsedByDefault
        for group in PanelKind.navGroups {
            if let title = group.title {
                XCTAssertTrue(state.isCollapsed(title), "expected \(title) collapsed by default")
            }
        }
    }

    func test_collapsedByDefault_leavesPinnedGroupOut() {
        // The pinned group has no header, so it can't be collapsed. .overview
        // lives there and must stay revealed.
        let state = NavCollapseState.collapsedByDefault
        XCTAssertEqual(state.collapsed.count, PanelKind.navGroups.compactMap(\.title).count)
    }
}
