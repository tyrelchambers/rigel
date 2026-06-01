import XCTest
@testable import Helmsman

final class CNPGTypesTests: XCTestCase {
    func test_clusterStatus_decodesBackupAndConditions() throws {
        let json = """
        {"metadata":{"uid":"u1","name":"pg"},
         "status":{"phase":"Cluster in healthy state","instances":3,"readyInstances":3,
           "currentPrimary":"pg-1","lastSuccessfulBackup":"2026-06-01T02:00:00Z",
           "conditions":[{"type":"ContinuousArchiving","status":"True","reason":"ContinuousArchivingSuccess"}]}}
        """.data(using: .utf8)!
        let c = try JSONDecoder().decode(CNPGCluster.self, from: json)
        XCTAssertEqual(c.status?.lastSuccessfulBackup, "2026-06-01T02:00:00Z")
        XCTAssertEqual(c.status?.conditions?.first?.type, "ContinuousArchiving")
        XCTAssertEqual(c.status?.conditions?.first?.status, "True")
    }

    func test_scheduledBackup_decodesScheduleAndCluster() throws {
        let json = """
        {"metadata":{"uid":"s1","name":"pg-daily","namespace":"default"},
         "spec":{"schedule":"0 0 2 * * *","cluster":{"name":"pg"}}}
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(CNPGScheduledBackup.self, from: json)
        XCTAssertEqual(s.spec?.schedule, "0 0 2 * * *")
        XCTAssertEqual(s.spec?.cluster?.name, "pg")
    }
}
