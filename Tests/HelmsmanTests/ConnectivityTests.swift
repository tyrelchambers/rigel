import XCTest
@testable import Helmsman

final class ConnectivityTests: XCTestCase {

    // MARK: Fixtures

    private func pod(_ name: String, ns: String = "default", labels: [String: String], phase: String = "Running", ready: Bool = true) -> Pod {
        Pod(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-\(name)", creationTimestamp: nil, labels: labels, annotations: nil),
            spec: PodSpec(nodeName: "n1", containers: []),
            status: PodStatus(phase: phase, podIP: nil,
                              containerStatuses: [ContainerStatus(name: "c", ready: ready, restartCount: 0, state: nil)])
        )
    }

    private func service(_ name: String, ns: String = "default", selector: [String: String]?, type: String = "ClusterIP") -> Service {
        Service(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-svc-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: Service.Spec(type: type, clusterIP: "10.0.0.1", selector: selector, ports: nil, externalName: nil, externalIPs: nil),
            status: nil
        )
    }

    /// Ingress with a single host → service rule.
    private func ingress(_ name: String, ns: String = "default", host: String, service: String) -> Ingress {
        let backend = Ingress.Backend(service: Ingress.ServiceBackend(name: service, port: Ingress.ServicePort(number: 80, name: nil)))
        let path = Ingress.Path(path: "/", pathType: "Prefix", backend: backend)
        let rule = Ingress.Rule(host: host, http: Ingress.HTTP(paths: [path]))
        return Ingress(
            metadata: ObjectMeta(name: name, namespace: ns, uid: "uid-ing-\(name)", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: Ingress.Spec(ingressClassName: "nginx", tls: nil, rules: [rule], defaultBackend: nil),
            status: nil
        )
    }

    // MARK: Tests

    func test_externalFlow_ingressToServiceToReadyPods_isOk() {
        let pods = [pod("web-1", labels: ["app": "web"]), pod("web-2", labels: ["app": "web"])]
        let svc = service("web", selector: ["app": "web"])
        let ing = ingress("web-ing", host: "myapp.com", service: "web")
        let flows = Connectivity.flows(ingresses: [ing], services: [svc], pods: pods)
        XCTAssertEqual(flows.count, 1)
        let f = flows[0]
        XCTAssertTrue(f.isExternal)
        XCTAssertEqual(f.hosts, ["myapp.com"])
        XCTAssertEqual(f.ingressNames, ["web-ing"])
        XCTAssertEqual(f.readyPods, 2)
        XCTAssertEqual(f.totalPods, 2)
        XCTAssertTrue(f.serviceExists)
        XCTAssertTrue(f.issues.isEmpty)
        XCTAssertEqual(f.health, .ok)
    }

    func test_danglingIngress_missingService_isBroken() {
        let ing = ingress("api-ing", host: "old.me", service: "ghost")
        let flows = Connectivity.flows(ingresses: [ing], services: [], pods: [])
        XCTAssertEqual(flows.count, 1)
        let f = flows[0]
        XCTAssertFalse(f.serviceExists)
        XCTAssertEqual(f.serviceName, "ghost")
        XCTAssertTrue(f.isExternal)
        XCTAssertEqual(f.health, .broken)
        XCTAssertFalse(f.issues.isEmpty)
    }

    func test_internalService_withReadyPods_isOkAndInternal() {
        let pods = [pod("db-0", labels: ["app": "db"])]
        let svc = service("postgres", selector: ["app": "db"])
        let flows = Connectivity.flows(ingresses: [], services: [svc], pods: pods)
        XCTAssertEqual(flows.count, 1)
        XCTAssertFalse(flows[0].isExternal)
        XCTAssertEqual(flows[0].health, .ok)
        XCTAssertEqual(flows[0].readyPods, 1)
    }

    func test_externalService_zeroReadyEndpoints_isBroken() {
        let pods = [pod("web-1", labels: ["app": "web"], ready: false)]
        let svc = service("web", selector: ["app": "web"])
        let ing = ingress("web-ing", host: "myapp.com", service: "web")
        let flows = Connectivity.flows(ingresses: [ing], services: [svc], pods: pods)
        XCTAssertEqual(flows[0].readyPods, 0)
        XCTAssertEqual(flows[0].totalPods, 1)
        XCTAssertEqual(flows[0].health, .broken)
    }

    func test_internalService_noBackingPods_isWarn() {
        let svc = service("orphan", selector: ["app": "nope"])
        let flows = Connectivity.flows(ingresses: [], services: [svc], pods: [])
        XCTAssertEqual(flows[0].health, .warn)
        XCTAssertEqual(flows[0].issues, ["Selector matches no pods"])
    }

    func test_noSelectorService_isOkWithNoPodIssue() {
        let svc = service("externalname", selector: nil, type: "ExternalName")
        let flows = Connectivity.flows(ingresses: [], services: [svc], pods: [])
        XCTAssertTrue(flows[0].issues.isEmpty)
        XCTAssertEqual(flows[0].health, .ok)
    }

    func test_sortsBrokenFirst() {
        let okSvc = service("web", selector: ["app": "web"])
        let okPods = [pod("web-1", labels: ["app": "web"])]
        let brokenIng = ingress("api-ing", host: "old.me", service: "ghost")
        let flows = Connectivity.flows(ingresses: [brokenIng], services: [okSvc], pods: okPods)
        XCTAssertEqual(flows.count, 2)
        XCTAssertEqual(flows.first?.health, .broken)
        XCTAssertEqual(flows.last?.health, .ok)
    }

    func test_multipleIngressesToOneService_mergesHostsAndNames() {
        let svc = service("web", selector: ["app": "web"])
        let pods = [pod("web-1", labels: ["app": "web"])]
        let prod = ingress("web-prod", host: "app.com", service: "web")
        let stg = ingress("web-stg", host: "staging.app.com", service: "web")
        let flows = Connectivity.flows(ingresses: [prod, stg], services: [svc], pods: pods)
        XCTAssertEqual(flows.count, 1)
        XCTAssertEqual(flows[0].hosts, ["app.com", "staging.app.com"])
        XCTAssertEqual(flows[0].ingressNames, ["web-prod", "web-stg"])
    }

    func test_ingressToNoSelectorService_isExternalAndOk() {
        // ExternalName / manually-managed endpoints behind an ingress: external,
        // but with no selector we can't assess endpoints, so it stays .ok.
        let svc = service("ext", selector: nil, type: "ExternalName")
        let ing = ingress("ext-ing", host: "ext.me", service: "ext")
        let flows = Connectivity.flows(ingresses: [ing], services: [svc], pods: [])
        XCTAssertTrue(flows[0].isExternal)
        XCTAssertTrue(flows[0].issues.isEmpty)
        XCTAssertEqual(flows[0].health, .ok)
    }

    func test_wildcardHost_excludedFromHostsButStillExternal() {
        let backend = Ingress.Backend(service: Ingress.ServiceBackend(name: "web", port: nil))
        let path = Ingress.Path(path: "/", pathType: "Prefix", backend: backend)
        let rule = Ingress.Rule(host: nil, http: Ingress.HTTP(paths: [path]))   // nil host → "*"
        let ing = Ingress(
            metadata: ObjectMeta(name: "wild", namespace: "default", uid: "uid-wild", creationTimestamp: nil, labels: nil, annotations: nil),
            spec: Ingress.Spec(ingressClassName: nil, tls: nil, rules: [rule], defaultBackend: nil),
            status: nil
        )
        let svc = service("web", selector: ["app": "web"])
        let pods = [pod("web-1", labels: ["app": "web"])]
        let flows = Connectivity.flows(ingresses: [ing], services: [svc], pods: pods)
        XCTAssertTrue(flows[0].isExternal)        // fronted by an ingress even with a wildcard host
        XCTAssertTrue(flows[0].hosts.isEmpty)     // "*" is not a displayable host
    }
}
