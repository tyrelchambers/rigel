import XCTest
@testable import ClaudeK8s

final class ContextHandoffBuilderLogSliceTests: XCTestCase {
    func test_logSliceIncludesPodAndSurrounding() {
        let target = LogLine(sourcePod: "default/postiz-x", timestamp: nil, text: "ERROR: connection refused", colorIndex: 0)
        let surrounding = [
            LogLine(sourcePod: "default/postiz-x", timestamp: nil, text: "connecting to postgres", colorIndex: 0),
            target,
            LogLine(sourcePod: "default/postiz-x", timestamp: nil, text: "retry 1/3", colorIndex: 0),
        ]
        let prompt = ContextHandoffBuilder.build(.logSlice(line: target, surrounding: surrounding))

        XCTAssertTrue(prompt.contains("default/postiz-x"))
        XCTAssertTrue(prompt.contains("connection refused"))
        XCTAssertTrue(prompt.contains("connecting to postgres"))
        XCTAssertTrue(prompt.contains("retry 1/3"))
    }
}
