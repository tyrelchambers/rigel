import XCTest
@testable import Helmsman

final class DatabasesViewModelTests: XCTestCase {
    func test_dsn_cnpgWithUsername() {
        let conn = ConnectionInfo(targetKind: "svc", targetName: "pg-rw", namespace: "default",
                                  port: 5432, scheme: "postgresql", secretName: "pg-app",
                                  username: "app", dbName: "app")
        XCTAssertEqual(DatabasesViewModel.dsn(for: conn),
                       "postgresql://app@pg-rw.default.svc:5432/app")
    }

    func test_dsn_genericNoCredsNoDB() {
        let conn = ConnectionInfo(targetKind: "pod", targetName: "redis-0", namespace: "default",
                                  port: 6379, scheme: "redis", secretName: nil,
                                  username: nil, dbName: nil)
        XCTAssertEqual(DatabasesViewModel.dsn(for: conn), "redis://redis-0.default:6379")
    }
}
