import XCTest
@testable import Helmsman

final class ContainerEnvTests: XCTestCase {
    func test_container_decodesEnvSecretRefs() throws {
        let json = """
        {"name":"db","image":"postgres:16",
         "env":[{"name":"PGPASSWORD","valueFrom":{"secretKeyRef":{"name":"db-creds","key":"password"}}}],
         "envFrom":[{"secretRef":{"name":"db-env"}}]}
        """.data(using: .utf8)!
        let c = try JSONDecoder().decode(Container.self, from: json)
        XCTAssertEqual(c.env?.first?.valueFrom?.secretKeyRef?.name, "db-creds")
        XCTAssertEqual(c.envFrom?.first?.secretRef?.name, "db-env")
    }
}
