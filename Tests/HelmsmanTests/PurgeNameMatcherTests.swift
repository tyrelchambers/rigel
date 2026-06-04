import XCTest
@testable import Helmsman

final class PurgeNameMatcherTests: XCTestCase {
    private let all = ["canada-hires-web", "canadahires-api", "canada-hires-web-staging",
                       "canadahires-api-staging", "reddex-deploy", "reddex-custom-website-deploy",
                       "big-o", "blog-deploy", "mysql", "postgres"]

    func test_groupsCanadaHiresVariants() {
        let r = Set(PurgeNameMatcher.relatedNames(root: "canada-hires-web", among: all))
        XCTAssertEqual(r, ["canada-hires-web", "canadahires-api",
                           "canada-hires-web-staging", "canadahires-api-staging"])
    }
    func test_groupsReddexVariants() {
        let r = Set(PurgeNameMatcher.relatedNames(root: "reddex-deploy", among: all))
        XCTAssertEqual(r, ["reddex-deploy", "reddex-custom-website-deploy"])
    }
    func test_doesNotGroupUnrelated() {
        let r = PurgeNameMatcher.relatedNames(root: "big-o", among: all)
        XCTAssertEqual(r, ["big-o"])
    }
    func test_shortCore_doesNotOverMerge() {
        // A 3-char core is too short to prefix-merge aggressively.
        XCTAssertEqual(PurgeNameMatcher.core("big-o"), "bigo")
    }
}
