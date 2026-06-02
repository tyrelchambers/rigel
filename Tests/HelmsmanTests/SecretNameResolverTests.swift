import XCTest
@testable import Helmsman

final class SecretNameResolverTests: XCTestCase {
    private func secret(_ name: String, labels: [String: String], data: [String: String] = [:]) -> Secret {
        Secret.draft(name: name, namespace: "default", type: .opaque, decodedData: data, labels: labels)
    }

    func test_freeName_usesBase() {
        let r = SecretNameResolver.resolve(instance: "plane", existing: [])
        XCTAssertEqual(r.name, "plane-secrets")
        XCTAssertEqual(r.note, .fresh)
        XCTAssertTrue(r.prefill.isEmpty)
    }

    func test_ourSecret_isReusedAndPrefilled() {
        let mine = secret("plane-secrets",
                          labels: ["app.kubernetes.io/managed-by": "helmsman",
                                   "app.kubernetes.io/instance": "plane"],
                          data: ["SECRET_KEY": "abc"])
        let r = SecretNameResolver.resolve(instance: "plane", existing: [mine])
        XCTAssertEqual(r.name, "plane-secrets")
        XCTAssertEqual(r.note, .reusing)
        XCTAssertEqual(r.prefill["SECRET_KEY"], "abc")
    }

    func test_unrelatedSecret_isSuffixed() {
        let other = secret("plane-secrets", labels: ["app": "something-else"])
        let r = SecretNameResolver.resolve(instance: "plane", existing: [other])
        XCTAssertEqual(r.name, "plane-secrets-2")
        XCTAssertEqual(r.note, .suffixed(requested: "plane-secrets"))
        XCTAssertTrue(r.prefill.isEmpty)
    }

    func test_multipleUnrelated_findsNextFree() {
        let a = secret("plane-secrets", labels: [:])
        let b = secret("plane-secrets-2", labels: [:])
        let r = SecretNameResolver.resolve(instance: "plane", existing: [a, b])
        XCTAssertEqual(r.name, "plane-secrets-3")
    }

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
