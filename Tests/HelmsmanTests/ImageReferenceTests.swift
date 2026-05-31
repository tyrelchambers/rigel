import XCTest
@testable import Helmsman

final class ImageReferenceTests: XCTestCase {

    func test_ghcrWithTag() {
        let ref = ImageReference("ghcr.io/plausible/community-edition:v2.1.4")
        XCTAssertEqual(ref?.registry, "ghcr.io")
        XCTAssertEqual(ref?.repository, "plausible/community-edition")
        XCTAssertEqual(ref?.tag, "v2.1.4")
    }

    func test_dockerHubNamespacedDefaultsRegistry() {
        let ref = ImageReference("vaultwarden/server:latest")
        XCTAssertEqual(ref?.registry, "docker.io")
        XCTAssertEqual(ref?.repository, "vaultwarden/server")
        XCTAssertEqual(ref?.tag, "latest")
    }

    func test_dockerHubOfficialImageGetsLibraryPrefix() {
        let ref = ImageReference("nextcloud:29-apache")
        XCTAssertEqual(ref?.registry, "docker.io")
        XCTAssertEqual(ref?.repository, "library/nextcloud")
        XCTAssertEqual(ref?.tag, "29-apache")
    }

    func test_dropsDigest() {
        let ref = ImageReference("vaultwarden/server:1.30@sha256:abcdef")
        XCTAssertEqual(ref?.repository, "vaultwarden/server")
        XCTAssertEqual(ref?.tag, "1.30")
    }

    func test_registryWithPortIsNotMistakenForTag() {
        let ref = ImageReference("localhost:5000/team/app:v1")
        XCTAssertEqual(ref?.registry, "localhost:5000")
        XCTAssertEqual(ref?.repository, "team/app")
        XCTAssertEqual(ref?.tag, "v1")
    }

    func test_noTag() {
        let ref = ImageReference("vaultwarden/server")
        XCTAssertEqual(ref?.repository, "vaultwarden/server")
        XCTAssertNil(ref?.tag)
    }

    func test_emptyStringIsNil() {
        XCTAssertNil(ImageReference("   "))
    }
}
