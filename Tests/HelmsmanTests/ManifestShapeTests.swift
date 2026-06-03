import XCTest
@testable import Helmsman

final class ManifestShapeTests: XCTestCase {
    func test_realMultiDocManifest_passes() {
        let yaml = """
        apiVersion: v1
        kind: Service
        metadata:
          name: web
        ---
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: web
        """
        XCTAssertNil(ManifestShape.validationError(yaml))
    }

    func test_valuesStyleDoc_isFlagged() {
        let yaml = """
        replicaCount: 2
        image:
          repository: nginx
          tag: latest
        service:
          port: 80
        """
        XCTAssertNotNil(ManifestShape.validationError(yaml))
    }

    func test_commentOnlyAndEmptyDocs_andTrailingSeparator_areIgnored() {
        let yaml = """
        # just a comment
        ---
        apiVersion: v1
        kind: ConfigMap
        metadata:
          name: cfg
        ---

        ---
        """
        XCTAssertNil(ManifestShape.validationError(yaml))
    }

    func test_indentedApiVersion_isFlagged() {
        // apiVersion present but indented (not top-level) — not a valid manifest.
        let yaml = """
        spec:
          apiVersion: v1
          kind: Pod
        """
        XCTAssertNotNil(ManifestShape.validationError(yaml))
    }

    func test_missingKind_isFlagged() {
        let yaml = """
        apiVersion: v1
        metadata:
          name: x
        """
        XCTAssertNotNil(ManifestShape.validationError(yaml))
    }
}
