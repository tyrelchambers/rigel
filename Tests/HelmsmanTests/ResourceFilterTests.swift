import XCTest
@testable import Helmsman

final class ResourceFilterTests: XCTestCase {
    private func cache(ns: String?) -> ClusterCache {
        let c = ClusterCache()
        c.namespaceFilter = ns
        return c
    }

    private func dep(_ name: String, ns: String) -> Deployment {
        Deployment(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-\(ns)-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: nil,
            status: nil
        )
    }

    func test_namespaceFilter_nil_returnsAllSortedByName() {
        let out = cache(ns: nil).filtered([dep("b", ns: "x"), dep("a", ns: "y")], search: "")
        XCTAssertEqual(out.map(\.metadata.name), ["a", "b"])
    }

    func test_namespaceFilter_set_keepsOnlyThatNamespace() {
        let out = cache(ns: "x").filtered([dep("a", ns: "x"), dep("b", ns: "y")], search: "")
        XCTAssertEqual(out.map(\.metadata.namespace), ["x"])
    }

    func test_search_matchesNameOrNamespace_caseInsensitive() {
        let items = [dep("memos", ns: "apps"), dep("web", ns: "default")]
        XCTAssertEqual(cache(ns: nil).filtered(items, search: "MEMO").map(\.metadata.name), ["memos"])
        XCTAssertEqual(cache(ns: nil).filtered(items, search: "apps").map(\.metadata.name), ["memos"])
    }

    func test_search_consultsMatchesClosure_forTypeSpecificFields() {
        // Only the closure can match this term — not name or namespace.
        let out = cache(ns: nil).filtered([dep("a", ns: "x"), dep("b", ns: "x")], search: "uid-x-b") { d, q in
            d.metadata.uid.localizedCaseInsensitiveContains(q)
        }
        XCTAssertEqual(out.map(\.metadata.name), ["b"])
    }

    func test_defaultSort_isNameOnly_ignoringNamespace() {
        let out = cache(ns: nil).filtered([dep("z", ns: "a"), dep("a", ns: "b")], search: "")
        XCTAssertEqual(out.map(\.metadata.name), ["a", "z"])
    }

    func test_groupByNamespace_sortsNamespaceThenName() {
        let items = [dep("z", ns: "a"), dep("a", ns: "b"), dep("b", ns: "a")]
        let out = cache(ns: nil).filtered(items, search: "", groupByNamespace: true)
        XCTAssertEqual(out.map { "\($0.metadata.namespace!)/\($0.metadata.name)" }, ["a/b", "a/z", "b/a"])
    }
}
