import XCTest
@testable import Helmsman

final class ManifestSummaryTests: XCTestCase {

    func test_parse_emptyOrGarbage_returnsNil() {
        XCTAssertNil(ManifestSummary.parse(""))
        XCTAssertNil(ManifestSummary.parse("   \n  "))
        XCTAssertNil(ManifestSummary.parse("just some prose, not yaml"))
    }

    func test_parse_fullStack_extractsEachResource() throws {
        let summary = try XCTUnwrap(ManifestSummary.parse(Self.memosManifest))

        // Workload
        XCTAssertEqual(summary.workloads.count, 1)
        let dep = summary.workloads[0]
        XCTAssertEqual(dep.kind, "Deployment")
        XCTAssertEqual(dep.name, "memos")
        XCTAssertEqual(dep.replicas, 1)
        XCTAssertEqual(dep.nodePin, "k8s")
        XCTAssertEqual(dep.labels["app.kubernetes.io/instance"], "memos")

        // Container image split + resources + ports
        let c = try XCTUnwrap(dep.containers.first)
        XCTAssertEqual(c.imageParts.repo, "neosmemo/memos")
        XCTAssertEqual(c.imageParts.tag, "0.22.4")
        XCTAssertEqual(c.cpuRequest, "100m")
        XCTAssertEqual(c.cpuLimit, "500m")
        XCTAssertEqual(c.memRequest, "128Mi")
        XCTAssertEqual(c.ports, [5230])

        // Service
        XCTAssertEqual(summary.services.count, 1)
        let svc = summary.services[0]
        XCTAssertEqual(svc.type, "ClusterIP")
        XCTAssertEqual(svc.ports.first?.port, 5230)
        XCTAssertEqual(svc.ports.first?.targetPort, "5230")

        // Ingress with TLS + host + backend
        XCTAssertEqual(summary.ingresses.count, 1)
        let ing = summary.ingresses[0]
        XCTAssertTrue(ing.tls)
        XCTAssertEqual(ing.rules.first?.host, "memos.example.com")
        XCTAssertEqual(ing.rules.first?.paths.first?.service, "memos")
        XCTAssertEqual(ing.rules.first?.paths.first?.port, "5230")

        // PVC
        XCTAssertEqual(summary.volumes.count, 1)
        XCTAssertEqual(summary.volumes[0].size, "1Gi")
        XCTAssertEqual(summary.volumes[0].accessModes, ["ReadWriteOnce"])
    }

    func test_parse_nodeSelectorHostname_isReadAsPin() throws {
        let yaml = """
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: app
        spec:
          replicas: 2
          template:
            spec:
              nodeSelector:
                kubernetes.io/hostname: worker-2
              containers:
                - name: app
                  image: nginx:1.27
        """
        let summary = try XCTUnwrap(ManifestSummary.parse(yaml))
        XCTAssertEqual(summary.workloads.first?.nodePin, "worker-2")
        XCTAssertEqual(summary.workloads.first?.containers.first?.imageParts.tag, "1.27")
    }

    func test_collapseManifestBlocks_replacesYAMLFenceKeepsProse() {
        let text = """
        Here's the manifest:
        ```yaml
        apiVersion: apps/v1
        kind: Deployment
        ```
        Let me know if you want changes.
        """
        let collapsed = WizardChatStrip.collapseManifestBlocks(text)
        XCTAssertFalse(collapsed.contains("apiVersion"))
        XCTAssertTrue(collapsed.contains("Here's the manifest"))
        XCTAssertTrue(collapsed.contains("Let me know if you want changes"))
    }

    func test_collapseManifestBlocks_defaultNounIsManifest() {
        let text = """
        Here are the values:
        ```yaml
        replicaCount: 2
        image:
          tag: latest
        ```
        Done.
        """
        let collapsed = WizardChatStrip.collapseManifestBlocks(text)
        XCTAssertTrue(collapsed.contains("📄 _manifest — shown above_"))
        XCTAssertFalse(collapsed.contains("values.yaml"))
        XCTAssertFalse(collapsed.contains("replicaCount"))
    }

    func test_collapseManifestBlocks_helmNounIsValuesYAML() {
        let text = """
        Here are the values:
        ```yaml
        replicaCount: 2
        image:
          tag: latest
        ```
        Done.
        """
        let collapsed = WizardChatStrip.collapseManifestBlocks(text, artifactNoun: "values.yaml")
        XCTAssertTrue(collapsed.contains("📄 _values.yaml — shown above_"))
        XCTAssertFalse(collapsed.contains("replicaCount"))
        XCTAssertTrue(collapsed.contains("Here are the values"))
    }

    private static let memosManifest = """
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: memos
      namespace: default
      labels:
        app.kubernetes.io/instance: memos
        app.kubernetes.io/name: memos
    spec:
      replicas: 1
      template:
        spec:
          nodeName: k8s
          containers:
            - name: memos
              image: neosmemo/memos:0.22.4
              ports:
                - containerPort: 5230
              resources:
                requests:
                  cpu: 100m
                  memory: 128Mi
                limits:
                  cpu: 500m
                  memory: 256Mi
    ---
    apiVersion: v1
    kind: Service
    metadata:
      name: memos
    spec:
      type: ClusterIP
      ports:
        - port: 5230
          targetPort: 5230
          protocol: TCP
    ---
    apiVersion: networking.k8s.io/v1
    kind: Ingress
    metadata:
      name: memos
    spec:
      tls:
        - hosts:
            - memos.example.com
          secretName: memos-tls
      rules:
        - host: memos.example.com
          http:
            paths:
              - path: /
                pathType: Prefix
                backend:
                  service:
                    name: memos
                    port:
                      number: 5230
    ---
    apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: memos-data
    spec:
      accessModes:
        - ReadWriteOnce
      resources:
        requests:
          storage: 1Gi
    """
}
