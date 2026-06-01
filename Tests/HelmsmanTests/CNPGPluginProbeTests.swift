import XCTest
@testable import Helmsman

final class CNPGPluginProbeTests: XCTestCase {
    func test_available_whenCommandSucceeds() async {
        let probe = CNPGPluginProbe(
            resolve: { _ in "/usr/local/bin/kubectl" },
            run: { _, _ in Data("cnpg version 1.25".utf8) }
        )
        let ok = await probe.isAvailable()
        XCTAssertTrue(ok)
    }

    func test_unavailable_whenCommandThrows() async {
        let probe = CNPGPluginProbe(
            resolve: { _ in "/usr/local/bin/kubectl" },
            run: { _, _ in throw ProcessError.nonZeroExit(code: 1, stderr: "unknown command \"cnpg\"") }
        )
        let ok = await probe.isAvailable()
        XCTAssertFalse(ok)
    }

    func test_unavailable_whenKubectlMissing() async {
        let probe = CNPGPluginProbe(resolve: { _ in nil }, run: { _, _ in Data() })
        let ok = await probe.isAvailable()
        XCTAssertFalse(ok)
    }
}
