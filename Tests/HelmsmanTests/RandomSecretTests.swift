import XCTest
@testable import Helmsman

final class RandomSecretTests: XCTestCase {
    func test_randomSecret_lengthAndCharset() {
        let v = RandomSecret.generate(length: 40)
        XCTAssertEqual(v.count, 40)
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        XCTAssertTrue(v.allSatisfy { allowed.contains($0) })
    }

    func test_randomSecret_minimumLength() {
        XCTAssertEqual(RandomSecret.generate(length: 0).count, 1)
    }
}
