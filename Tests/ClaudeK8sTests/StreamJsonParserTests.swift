import XCTest
@testable import ClaudeK8s

final class StreamJsonParserTests: XCTestCase {
    func test_splitsByNewlinesIncludingPartials() {
        var parser = StreamJsonParser()
        var lines: [String] = []
        parser.feed("{\"a\":1}\n{\"b".data(using: .utf8)!) { lines.append(String(data: $0, encoding: .utf8)!) }
        XCTAssertEqual(lines, ["{\"a\":1}"])
        parser.feed("\":2}\n".data(using: .utf8)!) { lines.append(String(data: $0, encoding: .utf8)!) }
        XCTAssertEqual(lines, ["{\"a\":1}", "{\"b\":2}"])
    }

    func test_parsesFixtureFile() throws {
        let url = Bundle.module.url(forResource: "claude-stream", withExtension: "jsonl")!
        let data = try Data(contentsOf: url)

        var parser = StreamJsonParser()
        var lines: [Data] = []
        parser.feed(data) { lines.append($0) }
        XCTAssertEqual(lines.count, 4)
    }
}
