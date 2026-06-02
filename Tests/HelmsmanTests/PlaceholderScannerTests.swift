import XCTest
@testable import Helmsman

final class PlaceholderScannerTests: XCTestCase {
    func test_scan_findsFillMeInMarkers() {
        let yaml = """
        apiVersion: v1
        kind: Secret
        metadata:
          name: app-secrets
        stringData:
          secretKey: "<FILL_ME_IN>"
          pgdbPassword: "<FILL_ME_IN>"
          pgdbName: plane
        """
        let keys = PlaceholderScanner.scan(yaml).map(\.key)
        XCTAssertEqual(keys, ["secretKey", "pgdbPassword"])
    }

    func test_scan_findsEmptyValuesInsideSecretBlock() {
        let yaml = """
        apiVersion: v1
        kind: Secret
        metadata:
          name: app-secrets
        stringData:
          TOKEN: ""
          OTHER: ''
          KEEP: "value"
        """
        let keys = PlaceholderScanner.scan(yaml).map(\.key)
        XCTAssertEqual(keys, ["TOKEN", "OTHER"])
    }

    func test_scan_ignoresEmptyValuesOutsideSecret() {
        // An empty env value on a Deployment is legitimate config, not a secret to fill.
        let yaml = """
        apiVersion: apps/v1
        kind: Deployment
        spec:
          template:
            spec:
              containers:
                - name: app
                  env:
                    - name: OPTIONAL
                      value: ""
        """
        XCTAssertTrue(PlaceholderScanner.scan(yaml).isEmpty)
    }

    func test_scan_dedupesAcrossDocuments() {
        let yaml = """
        kind: Secret
        stringData:
          shared: "<FILL_ME_IN>"
        ---
        kind: ConfigMap
        data:
          ref: "<FILL_ME_IN>"
        """
        XCTAssertEqual(PlaceholderScanner.scan(yaml).map(\.key), ["shared", "ref"])
    }

    func test_substitute_replacesMarkerInPlacePreservingQuotes() {
        let yaml = "kind: Secret\nstringData:\n  secretKey: \"<FILL_ME_IN>\""
        let out = PlaceholderScanner.substitute(yaml, values: ["secretKey": "abc123"])
        XCTAssertTrue(out.contains("secretKey: \"abc123\""))
        XCTAssertFalse(out.contains("<FILL_ME_IN>"))
    }

    func test_substitute_fillsEmptySecretValue() {
        let yaml = "kind: Secret\nstringData:\n  TOKEN: \"\""
        let out = PlaceholderScanner.substitute(yaml, values: ["TOKEN": "xyz"])
        XCTAssertTrue(out.contains("TOKEN: 'xyz'"))
    }

    func test_substitute_leavesUnrelatedLinesUntouched() {
        let yaml = "kind: Secret\nstringData:\n  a: \"<FILL_ME_IN>\"\n  b: keep"
        let out = PlaceholderScanner.substitute(yaml, values: ["a": "filled"])
        XCTAssertTrue(out.contains("b: keep"))
    }

    func test_hasUnfilledPlaceholders_guard() {
        XCTAssertTrue(PlaceholderScanner.hasUnfilledMarkers("x: \"<FILL_ME_IN>\""))
        XCTAssertFalse(PlaceholderScanner.hasUnfilledMarkers("x: filled"))
    }
}
