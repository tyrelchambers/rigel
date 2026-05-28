import XCTest
@testable import Helmsman

final class IngressTests: XCTestCase {
    func test_draft_toYAML_basicRoute() {
        let ing = Ingress.draft(
            name: "web",
            namespace: "default",
            className: "nginx",
            rules: [.init(host: "app.example.com", path: "/", pathType: "Prefix", service: "web-svc", port: "80")],
            tls: [],
            annotations: [:]
        )
        let yaml = ing.toYAML()
        XCTAssertTrue(yaml.contains("apiVersion: networking.k8s.io/v1"))
        XCTAssertTrue(yaml.contains("kind: Ingress"))
        XCTAssertTrue(yaml.contains("name: 'web'"))
        XCTAssertTrue(yaml.contains("namespace: 'default'"))
        XCTAssertTrue(yaml.contains("ingressClassName: 'nginx'"))
        XCTAssertTrue(yaml.contains("host: 'app.example.com'"))
        XCTAssertTrue(yaml.contains("path: '/'"))
        XCTAssertTrue(yaml.contains("pathType: 'Prefix'"))
        XCTAssertTrue(yaml.contains("name: 'web-svc'"))
        XCTAssertTrue(yaml.contains("number: 80"))
    }

    func test_draft_groupsPathsByHost() {
        let ing = Ingress.draft(
            name: "web", namespace: "default", className: "nginx",
            rules: [
                .init(host: "a.com", path: "/", pathType: "Prefix", service: "svc-a", port: "80"),
                .init(host: "a.com", path: "/api", pathType: "Prefix", service: "svc-api", port: "8080"),
            ],
            tls: [], annotations: [:]
        )
        // Two paths, one host → one Rule with two Paths.
        XCTAssertEqual(ing.spec?.rules?.count, 1)
        XCTAssertEqual(ing.spec?.rules?.first?.http?.paths.count, 2)
    }

    func test_draft_namedPort() {
        let ing = Ingress.draft(
            name: "web", namespace: "default", className: "",
            rules: [.init(host: "a.com", path: "/", pathType: "Prefix", service: "svc", port: "http")],
            tls: [], annotations: [:]
        )
        XCTAssertTrue(ing.toYAML().contains("name: 'http'"))
        XCTAssertFalse(ing.toYAML().contains("number:"))
    }

    func test_draft_skipsRowsWithEmptyService() {
        let ing = Ingress.draft(
            name: "web", namespace: "default", className: "",
            rules: [.init(host: "a.com", path: "/", pathType: "Prefix", service: "  ", port: "80")],
            tls: [], annotations: [:]
        )
        XCTAssertNil(ing.spec?.rules)
    }

    func test_draft_tlsGroupedBySecret() {
        let ing = Ingress.draft(
            name: "web", namespace: "default", className: "nginx",
            rules: [.init(host: "a.com", path: "/", pathType: "Prefix", service: "svc", port: "80")],
            tls: [
                .init(host: "a.com", secretName: "web-tls"),
                .init(host: "b.com", secretName: "web-tls"),
            ],
            annotations: [:]
        )
        XCTAssertEqual(ing.spec?.tls?.count, 1)
        XCTAssertEqual(ing.spec?.tls?.first?.hosts?.count, 2)
        XCTAssertEqual(ing.spec?.tls?.first?.secretName, "web-tls")
    }

    func test_toYAML_annotationsSortedAndQuoted() {
        let ing = Ingress.draft(
            name: "web", namespace: "default", className: "",
            rules: [], tls: [],
            annotations: ["nginx.ingress.kubernetes.io/ssl-redirect": "true"]
        )
        XCTAssertTrue(ing.toYAML().contains("'nginx.ingress.kubernetes.io/ssl-redirect': 'true'"))
    }

    func test_editableAnnotations_dropsLastApplied() {
        let meta = ObjectMeta(
            name: "web", namespace: "default", uid: "u1", creationTimestamp: nil,
            labels: nil,
            annotations: [
                "kubectl.kubernetes.io/last-applied-configuration": "{...}",
                "keep": "yes",
            ]
        )
        let ing = Ingress(metadata: meta, spec: nil, status: nil)
        XCTAssertEqual(ing.editableAnnotations, ["keep": "yes"])
    }

    func test_toYAML_emptyPort_omitsPortBlock() {
        let ing = Ingress.draft(
            name: "web", namespace: "default", className: "",
            rules: [.init(host: "a.com", path: "/", pathType: "Prefix", service: "svc", port: "")],
            tls: [], annotations: [:]
        )
        let yaml = ing.toYAML()
        XCTAssertTrue(yaml.contains("name: 'svc'"))
        XCTAssertFalse(yaml.contains("port:"))
    }

    func test_tlsDrafts_roundTripFromSpec() {
        let ing = Ingress.draft(
            name: "web", namespace: "default", className: "nginx",
            rules: [.init(host: "a.com", path: "/", pathType: "Prefix", service: "svc", port: "80")],
            tls: [.init(host: "a.com", secretName: "web-tls"),
                  .init(host: "b.com", secretName: "web-tls")],
            annotations: [:]
        )
        let drafts = ing.tlsDrafts
        XCTAssertEqual(drafts.count, 2)
        XCTAssertTrue(drafts.allSatisfy { $0.secretName == "web-tls" })
        XCTAssertEqual(Set(drafts.map(\.host)), ["a.com", "b.com"])
    }

    func test_ruleDrafts_roundTripFromSpec() {
        let ing = Ingress.draft(
            name: "web", namespace: "default", className: "nginx",
            rules: [.init(host: "a.com", path: "/api", pathType: "Exact", service: "svc", port: "8080")],
            tls: [], annotations: [:]
        )
        let drafts = ing.ruleDrafts
        XCTAssertEqual(drafts.count, 1)
        XCTAssertEqual(drafts[0].host, "a.com")
        XCTAssertEqual(drafts[0].path, "/api")
        XCTAssertEqual(drafts[0].pathType, "Exact")
        XCTAssertEqual(drafts[0].service, "svc")
        XCTAssertEqual(drafts[0].port, "8080")
    }
}
