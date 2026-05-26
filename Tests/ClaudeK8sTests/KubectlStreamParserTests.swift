import XCTest
@testable import ClaudeK8s

final class KubectlStreamParserTests: XCTestCase {
    func test_splitsTwoPrettyPrintedObjects() throws {
        let url = Bundle.module.url(forResource: "watch-events-pretty", withExtension: "json")!
        let data = try Data(contentsOf: url)

        var parser = KubectlStreamParser()
        var values: [Data] = []
        parser.feed(data) { values.append($0) }

        XCTAssertEqual(values.count, 2)

        // Each emitted Data must be standalone-decodable.
        let first = try JSONSerialization.jsonObject(with: values[0]) as? [String: Any]
        XCTAssertEqual(first?["kind"] as? String, "Pod")

        let second = try JSONSerialization.jsonObject(with: values[1]) as? [String: Any]
        let meta = second?["metadata"] as? [String: Any]
        XCTAssertEqual(meta?["name"] as? String, "postiz-844c9f-abcde")
    }

    func test_handlesPartialThenComplete() {
        var parser = KubectlStreamParser()
        var values: [Data] = []
        parser.feed(Data("{\"a\":1}{\"b".utf8)) { values.append($0) }
        XCTAssertEqual(values.count, 1)
        parser.feed(Data(":2}".utf8)) { values.append($0) }
        XCTAssertEqual(values.count, 2)
    }

    func test_handlesStringWithEscapedBraces() {
        var parser = KubectlStreamParser()
        var values: [Data] = []
        parser.feed(Data(#"{"s":"a\"}b"}"#.utf8)) { values.append($0) }
        XCTAssertEqual(values.count, 1)
        XCTAssertEqual(values[0], Data(#"{"s":"a\"}b"}"#.utf8))
    }
}
