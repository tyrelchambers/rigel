import XCTest
@testable import Helmsman

final class UsageSeriesSourceTests: XCTestCase {

    func test_promRangeResponse_decodesMatrixValues() throws {
        let json = """
        {"status":"success","data":{"resultType":"matrix","result":[
          {"metric":{},"values":[[1000,"0.5"],[1300,"1.25"]]}
        ]}}
        """.data(using: .utf8)!
        let resp = try JSONDecoder().decode(PromRangeResponse.self, from: json)
        XCTAssertEqual(resp.status, "success")
        let pts = resp.data.result.first?.values ?? []
        XCTAssertEqual(pts.count, 2)
        XCTAssertEqual(pts[0].time, 1000, accuracy: 0.001)
        XCTAssertEqual(pts[1].value, 1.25, accuracy: 0.001)
    }

    func test_series_returnsEmptyForLocalBackend() async {
        let cache = ClusterCache()
        let source = UsageSeriesSource(backend: .local)
        let pts = await source.series(via: cache, namespace: "default", name: "web", metric: .cpu)
        XCTAssertTrue(pts.isEmpty)
    }
}
