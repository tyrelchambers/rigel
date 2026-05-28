import XCTest
@testable import Helmsman

final class KubeconfigParserTests: XCTestCase {
    func test_parsesContextsAndCurrent() throws {
        let url = Bundle.module.url(forResource: "kubeconfig-min", withExtension: "yaml")!
        let yaml = try String(contentsOf: url)

        let config = try KubeconfigParser.parse(yaml)

        XCTAssertEqual(config.currentContext, "homelab")
        XCTAssertEqual(config.contexts.count, 2)
        XCTAssertEqual(config.contexts.map(\.name).sorted(), ["homelab", "prod"])
        XCTAssertEqual(config.contexts.first(where: { $0.name == "homelab" })?.namespace, "default")
    }
}
