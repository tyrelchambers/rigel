import XCTest
@testable import Helmsman

final class TagSourceTests: XCTestCase {

    func test_githubParseTag_extractsTagName() {
        let json = #"{"tag_name":"v2.1.4","name":"Release 2.1.4","prerelease":false}"#
        let data = Data(json.utf8)
        XCTAssertEqual(GitHubReleaseSource.parseTag(data), "v2.1.4")
    }

    func test_githubParseTag_missingField_returnsNil() {
        let data = Data(#"{"name":"no tag here"}"#.utf8)
        XCTAssertNil(GitHubReleaseSource.parseTag(data))
    }

    func test_githubParseTag_garbage_returnsNil() {
        XCTAssertNil(GitHubReleaseSource.parseTag(Data("not json".utf8)))
    }
}
