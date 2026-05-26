import XCTest
@testable import ClaudeK8s

final class LogLineParserTests: XCTestCase {
    func test_parsesTimestampedLine() {
        let raw = "2026-05-26T18:42:01.123Z hello world"
        let line = LogLineParser.parse(raw, sourcePod: "default/x", colorIndex: 3)
        XCTAssertEqual(line.text, "hello world")
        XCTAssertNotNil(line.timestamp)
        XCTAssertEqual(line.colorIndex, 3)
        XCTAssertEqual(line.sourcePod, "default/x")
    }

    func test_parsesUntimestampedLine() {
        let line = LogLineParser.parse("plain text", sourcePod: "default/x", colorIndex: 0)
        XCTAssertEqual(line.text, "plain text")
        XCTAssertNil(line.timestamp)
    }

    func test_streamsMultipleLinesFromBuffer() {
        var parser = LogLineStreamParser(sourcePod: "default/x", colorIndex: 0)
        var lines: [LogLine] = []
        parser.feed(Data("first\nsecond\nthi".utf8)) { lines.append($0) }
        XCTAssertEqual(lines.map(\.text), ["first", "second"])
        parser.feed(Data("rd\n".utf8)) { lines.append($0) }
        XCTAssertEqual(lines.map(\.text), ["first", "second", "third"])
    }

    func test_extractsKubectlPrefix() {
        let raw = "[pod/fieldnotes-7d9c8b6f5d-xk2vp/nginx] 2026-05-26T18:42:01.123Z GET / 200"
        let line = LogLineParser.parse(raw, sourcePod: "fallback", colorIndex: 5)
        XCTAssertEqual(line.sourcePod, "fieldnotes-7d9c8b6f5d-xk2vp")
        XCTAssertNotNil(line.timestamp)
        XCTAssertEqual(line.text, "GET / 200")
        XCTAssertEqual(line.colorIndex, PodColorAssigner.colorIndex(for: "fieldnotes-7d9c8b6f5d-xk2vp"))
    }

    func test_keepsFallbackSourceWhenNoPrefix() {
        let line = LogLineParser.parse("plain log line", sourcePod: "fallback-key", colorIndex: 3)
        XCTAssertEqual(line.sourcePod, "fallback-key")
        XCTAssertEqual(line.colorIndex, 3)
    }
}
