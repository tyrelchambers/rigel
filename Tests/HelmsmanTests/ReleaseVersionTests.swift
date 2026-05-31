import XCTest
@testable import Helmsman

final class ReleaseVersionTests: XCTestCase {

    // MARK: - Parsing

    func test_parsesPlainSemver() {
        let v = ReleaseVersion(tag: "v3.2.1")
        XCTAssertEqual(v?.components, [3, 2, 1])
        XCTAssertEqual(v?.isPrerelease, false)
    }

    func test_parsesTwoComponent() {
        XCTAssertEqual(ReleaseVersion(tag: "1.22")?.components, [1, 22])
    }

    func test_parsesFourComponent() {
        XCTAssertEqual(ReleaseVersion(tag: "15.1.0.147")?.components, [15, 1, 0, 147])
    }

    func test_variantSuffixIsStable() {
        // `-alpine` is a flavor, not a pre-release.
        let v = ReleaseVersion(tag: "24.3-alpine")
        XCTAssertEqual(v?.components, [24, 3])
        XCTAssertEqual(v?.isPrerelease, false)
    }

    func test_rcSuffixIsPrerelease() {
        XCTAssertEqual(ReleaseVersion(tag: "v3.0.0-rc.4")?.isPrerelease, true)
        XCTAssertEqual(ReleaseVersion(tag: "2.1.5-rc.1")?.isPrerelease, true)
    }

    func test_rejectsNonVersionTags() {
        XCTAssertNil(ReleaseVersion(tag: "latest"))
        XCTAssertNil(ReleaseVersion(tag: "stable"))
        XCTAssertNil(ReleaseVersion(tag: "main"))
        XCTAssertNil(ReleaseVersion(tag: ""))
    }

    func test_latestAlpineIsNotAVersion() {
        // No numeric core at all.
        XCTAssertNil(ReleaseVersion(tag: "latest-alpine"))
    }

    // MARK: - Comparison

    func test_numericOrdering() {
        XCTAssertLessThan(ReleaseVersion(tag: "1.22")!, ReleaseVersion(tag: "1.100")!)
        XCTAssertLessThan(ReleaseVersion(tag: "v2.1.4")!, ReleaseVersion(tag: "v3.2.1")!)
    }

    func test_shorterPrefixRanksLower() {
        XCTAssertLessThan(ReleaseVersion(tag: "1.2")!, ReleaseVersion(tag: "1.2.1")!)
    }

    func test_stableOutranksPrereleaseOfSameNumbers() {
        XCTAssertLessThan(ReleaseVersion(tag: "3.0.0-rc.1")!, ReleaseVersion(tag: "3.0.0")!)
    }

    // MARK: - newestStableUpgrade (the Plausible scenario)

    func test_picksNewestStableIgnoringPrereleases() {
        let tags = ["v2.1.2", "v2.1.3", "v2.1.4", "v2.1.5-rc.1", "v2.1.5",
                    "v3.0.0-rc.6", "v3", "v3.0", "v3.0.0", "v3.0.1",
                    "v3.1.0", "v3.2.0-rc.0", "v3.2.0", "v3.2.1", "latest"]
        XCTAssertEqual(newestStableUpgrade(currentTag: "v2.1.4", availableTags: tags), "v3.2.1")
    }

    func test_returnsNilWhenOnAreNewest() {
        let tags = ["1.20", "1.21", "1.22"]
        XCTAssertNil(newestStableUpgrade(currentTag: "1.22", availableTags: tags))
    }

    func test_ignoresPrereleaseEvenIfNumericallyHigher() {
        let tags = ["1.0.0", "2.0.0-rc.1"]
        XCTAssertNil(newestStableUpgrade(currentTag: "1.0.0", availableTags: tags))
    }

    func test_returnsNilForUnparseableCurrent() {
        XCTAssertNil(newestStableUpgrade(currentTag: "latest", availableTags: ["1.0.0", "2.0.0"]))
    }
}
