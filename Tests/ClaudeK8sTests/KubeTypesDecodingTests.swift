import XCTest
@testable import ClaudeK8s

final class KubeTypesDecodingTests: XCTestCase {
    func test_decodePodList_extractsBothPods() throws {
        let url = Bundle.module.url(forResource: "pods-list", withExtension: "json")!
        let data = try Data(contentsOf: url)
        let list = try JSONDecoder.kube.decode(KubeList<Pod>.self, from: data)

        XCTAssertEqual(list.items.count, 2)
        XCTAssertEqual(list.items[0].metadata.name, "fieldnotes-7d9c8b6f5d-xk2vp")
        XCTAssertEqual(list.items[0].status?.phase, "Running")
        XCTAssertEqual(list.items[0].spec?.nodeName, "k8s")

        XCTAssertEqual(list.items[1].metadata.name, "postiz-844c9f-abcde")
        XCTAssertEqual(list.items[1].status?.phase, "Pending")
        XCTAssertEqual(list.items[1].status?.containerStatuses?.first?.state?.waiting?.reason, "CrashLoopBackOff")
    }
}
