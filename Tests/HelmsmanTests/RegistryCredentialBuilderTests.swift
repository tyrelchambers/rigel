import XCTest
@testable import Helmsman

final class RegistryCredentialBuilderTests: XCTestCase {
    func test_authsKey_dockerHubUsesV1Endpoint() {
        XCTAssertEqual(RegistryCredentialBuilder.authsKey(for: "docker.io"), "https://index.docker.io/v1/")
        XCTAssertEqual(RegistryCredentialBuilder.authsKey(for: ""), "https://index.docker.io/v1/")
        XCTAssertEqual(RegistryCredentialBuilder.authsKey(for: "ghcr.io"), "ghcr.io")
        XCTAssertEqual(RegistryCredentialBuilder.authsKey(for: "quay.io"), "quay.io")
        XCTAssertEqual(RegistryCredentialBuilder.authsKey(for: "registry-1.docker.io"), "https://index.docker.io/v1/")
        XCTAssertEqual(RegistryCredentialBuilder.authsKey(for: "  GHCR.IO  "), "ghcr.io")
    }

    func test_dockerConfigJSON_dockerHubUsesV1Key() throws {
        let json = RegistryCredentialBuilder.dockerConfigJSON(registry: "docker.io", username: "u", token: "t")
        let obj = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
        let auths = obj["auths"] as! [String: Any]
        XCTAssertNotNil(auths["https://index.docker.io/v1/"])
        XCTAssertNil(auths["docker.io"])
    }

    func test_dockerConfigJSON_hasAuthsWithBase64Auth() throws {
        let json = RegistryCredentialBuilder.dockerConfigJSON(registry: "ghcr.io", username: "tyrel", token: "secret")
        let obj = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
        let auths = obj["auths"] as! [String: Any]
        let entry = auths["ghcr.io"] as! [String: Any]
        XCTAssertEqual(entry["username"] as? String, "tyrel")
        XCTAssertEqual(entry["password"] as? String, "secret")
        XCTAssertEqual(entry["auth"] as? String, Data("tyrel:secret".utf8).base64EncodedString())
    }
}
