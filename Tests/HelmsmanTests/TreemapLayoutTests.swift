import XCTest
import CoreGraphics
@testable import Helmsman

final class TreemapLayoutTests: XCTestCase {

    func test_squarify_areasAreProportionalAndCoverRect() {
        let rect = CGRect(x: 0, y: 0, width: 60, height: 10)   // area 600
        let weights = [3.0, 2.0, 1.0]                          // total 6 → scale 100
        let rects = TreemapLayout.squarify(weights, in: rect)
        XCTAssertEqual(rects.count, 3)
        XCTAssertEqual(rects[0].width * rects[0].height, 300, accuracy: 0.001)
        XCTAssertEqual(rects[1].width * rects[1].height, 200, accuracy: 0.001)
        XCTAssertEqual(rects[2].width * rects[2].height, 100, accuracy: 0.001)
        let covered = rects.reduce(0.0) { $0 + $1.width * $1.height }
        XCTAssertEqual(covered, 600, accuracy: 0.001)
    }

    func test_squarify_zeroWeightsGetZeroRect() {
        let rect = CGRect(x: 0, y: 0, width: 100, height: 100)
        let rects = TreemapLayout.squarify([1.0, 0.0, 1.0], in: rect)
        XCTAssertEqual(rects[1], .zero)
        XCTAssertEqual(rects[0].width * rects[0].height, 5000, accuracy: 0.001)
    }

    func test_squarify_emptyOrDegenerateReturnsZeros() {
        XCTAssertTrue(TreemapLayout.squarify([], in: CGRect(x: 0, y: 0, width: 10, height: 10)).isEmpty)
        let rects = TreemapLayout.squarify([1, 1], in: .zero)
        XCTAssertEqual(rects, [.zero, .zero])
    }

    func test_squarify_rectsStayInsideBounds() {
        let rect = CGRect(x: 0, y: 0, width: 200, height: 120)
        let rects = TreemapLayout.squarify([5, 3, 2, 8, 1, 4], in: rect)
        for r in rects where r != .zero {
            XCTAssertGreaterThanOrEqual(r.minX, -0.001)
            XCTAssertGreaterThanOrEqual(r.minY, -0.001)
            XCTAssertLessThanOrEqual(r.maxX, rect.width + 0.001)
            XCTAssertLessThanOrEqual(r.maxY, rect.height + 0.001)
        }
    }
}
