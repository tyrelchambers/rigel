import XCTest
@testable import ClaudeK8s

final class PodColorAssignerTests: XCTestCase {
    func test_stableSameKeyAcrossInstances() {
        XCTAssertEqual(PodColorAssigner.colorIndex(for: "default/postiz-844c9f-abcde"),
                       PodColorAssigner.colorIndex(for: "default/postiz-844c9f-abcde"))
    }

    func test_resultInPaletteRange() {
        for i in 0..<50 {
            let idx = PodColorAssigner.colorIndex(for: "default/pod-\(i)")
            XCTAssertGreaterThanOrEqual(idx, 0)
            XCTAssertLessThan(idx, PodColorAssigner.paletteSize)
        }
    }

    func test_differentKeysDistributeAcrossPalette() {
        var counts = Array(repeating: 0, count: PodColorAssigner.paletteSize)
        for i in 0..<800 {
            counts[PodColorAssigner.colorIndex(for: "default/pod-\(i)")] += 1
        }
        for c in counts { XCTAssertGreaterThan(c, 0) }
    }
}
