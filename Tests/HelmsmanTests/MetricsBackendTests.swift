import XCTest
@testable import Helmsman

final class MetricsBackendTests: XCTestCase {

    // MARK: - Config

    func test_proxyBase_onlyForPrometheus() {
        XCTAssertNil(MetricsBackendConfig.local.proxyBase)
        let p = MetricsBackendConfig.prometheus(namespace: "monitoring", service: "prometheus", port: 9090)
        XCTAssertEqual(p.proxyBase, "/api/v1/namespaces/monitoring/services/prometheus:9090/proxy")
        XCTAssertTrue(p.isPrometheus)
    }

    func test_flavorLabel_inferredFromPort() {
        XCTAssertEqual(MetricsBackendConfig.local.flavorLabel, "Local")
        XCTAssertEqual(MetricsBackendConfig.prometheus(namespace: "m", service: "s", port: 8428).flavorLabel, "VictoriaMetrics")
        XCTAssertEqual(MetricsBackendConfig.prometheus(namespace: "m", service: "s", port: 9090).flavorLabel, "Prometheus")
        XCTAssertEqual(MetricsBackendConfig.prometheus(namespace: "m", service: "s", port: 1234).flavorLabel, "Metrics")
    }

    func test_config_codableRoundTrip() throws {
        let p = MetricsBackendConfig.prometheus(namespace: "m", service: "vmsingle", port: 8428, stepSeconds: 30)
        let data = try JSONEncoder().encode(p)
        let back = try JSONDecoder().decode(MetricsBackendConfig.self, from: data)
        XCTAssertEqual(p, back)
    }

    // MARK: - Detection

    private func svc(_ name: String, ns: String, ports: [Int], portNames: [String?] = []) -> Service {
        let meta = ObjectMeta(name: name, namespace: ns, uid: name, creationTimestamp: nil, labels: nil, annotations: nil)
        let p = ports.enumerated().map { i, port in
            Service.Port(name: portNames.indices.contains(i) ? portNames[i] : nil, port: port, targetPort: nil, protocol: "TCP", nodePort: nil)
        }
        return Service(metadata: meta, spec: Service.Spec(type: "ClusterIP", clusterIP: "1.2.3.4", selector: nil, ports: p, externalName: nil, externalIPs: nil), status: nil)
    }

    func test_detect_prometheus() {
        let found = MetricsBackendDetector.detect(in: [svc("prometheus-server", ns: "monitoring", ports: [9090, 80])])
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found[0].namespace, "monitoring")
        XCTAssertEqual(found[0].service, "prometheus-server")
        XCTAssertEqual(found[0].port, 9090)
    }

    func test_detect_victoriaMetrics() {
        let found = MetricsBackendDetector.detect(in: [svc("vmsingle-victoria", ns: "vm", ports: [8428])])
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(found[0].port, 8428)
    }

    func test_detect_skipsExportersAndOperators() {
        let services = [
            svc("prometheus-operator", ns: "monitoring", ports: [8080]),
            svc("node-exporter", ns: "monitoring", ports: [9100]),
            svc("alertmanager", ns: "monitoring", ports: [9093]),
            svc("kube-state-metrics", ns: "monitoring", ports: [8080]),
        ]
        XCTAssertTrue(MetricsBackendDetector.detect(in: services).isEmpty)
    }

    func test_detect_dedupes() {
        let s = svc("prometheus", ns: "monitoring", ports: [9090])
        XCTAssertEqual(MetricsBackendDetector.detect(in: [s, s]).count, 1)
    }

    // MARK: - PromQL response decoding

    func test_promResponse_decode() throws {
        let json = """
        {"status":"success","data":{"resultType":"vector","result":[
          {"metric":{"container":"app"},"value":[1717000000.5,"268435456"]},
          {"metric":{"container":"sidecar"},"value":[1717000000.5,"12.5"]}
        ]}}
        """
        let resp = try JSONDecoder().decode(PromQueryResponse.self, from: Data(json.utf8))
        XCTAssertEqual(resp.status, "success")
        XCTAssertEqual(resp.data.result.count, 2)
        XCTAssertEqual(resp.data.result[0].metric["container"], "app")
        XCTAssertEqual(resp.data.result[0].value.value, 268435456, accuracy: 1)
        XCTAssertEqual(resp.data.result[1].value.value, 12.5, accuracy: 0.001)
    }

    func test_promResponse_emptyResult() throws {
        let json = #"{"status":"success","data":{"resultType":"vector","result":[]}}"#
        let resp = try JSONDecoder().decode(PromQueryResponse.self, from: Data(json.utf8))
        XCTAssertTrue(resp.data.result.isEmpty)
    }
}
