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

    // MARK: - GHCR tag-list pagination

    private let ghcrBase = URL(string: "https://ghcr.io")!

    func test_ghcrNextPageURL_followsRelNext() {
        // GHCR returns tags oldest-first capped at 100/page; the newest releases
        // are only reachable by following the Link header's rel="next".
        let header = #"</v2/paperless-ngx/paperless-ngx/tags/list?last=2.9.0&n=100>; rel="next""#
        let next = GHCRTagSource.nextPageURL(linkHeader: header, base: ghcrBase)
        XCTAssertEqual(next?.absoluteString,
                       "https://ghcr.io/v2/paperless-ngx/paperless-ngx/tags/list?last=2.9.0&n=100")
    }

    func test_ghcrNextPageURL_noHeader_returnsNil() {
        XCTAssertNil(GHCRTagSource.nextPageURL(linkHeader: nil, base: ghcrBase))
    }

    func test_ghcrNextPageURL_onlyPrev_returnsNil() {
        let header = #"</v2/x/y/tags/list?last=1.0.0&n=100>; rel="prev""#
        XCTAssertNil(GHCRTagSource.nextPageURL(linkHeader: header, base: ghcrBase))
    }

    func test_ghcrParseTags_decodesNames() {
        let data = Data(#"{"name":"x/y","tags":["1.0.0","1.1.0","latest"]}"#.utf8)
        XCTAssertEqual(GHCRTagSource.parseTags(data), ["1.0.0", "1.1.0", "latest"])
    }
}
