import XCTest
@testable import Helmsman

final class RegistryAccountReconcilerTests: XCTestCase {
    func test_unionImagePullSecrets_appendsWithoutDuplicates_preservingExisting() {
        XCTAssertEqual(
            RegistryAccountReconciler.unionImagePullSecrets(existing: ["other"], adding: "helmsman-dockerhub"),
            ["other", "helmsman-dockerhub"])
        XCTAssertEqual(
            RegistryAccountReconciler.unionImagePullSecrets(existing: ["helmsman-dockerhub"], adding: "helmsman-dockerhub"),
            ["helmsman-dockerhub"])   // idempotent
        XCTAssertEqual(
            RegistryAccountReconciler.unionImagePullSecrets(existing: [], adding: "a"),
            ["a"])
    }

    func test_saMergePatch_emitsFullList() {
        let patch = RegistryAccountReconciler.saMergePatch(secretNames: ["a", "b"])
        XCTAssertEqual(patch, #"{"imagePullSecrets":[{"name":"a"},{"name":"b"}]}"#)
    }

    func test_secretCopied_retargetsNamespaceAndStripsServerMetadata() {
        let original = Secret.draft(name: "regcred", namespace: "default", type: .dockerconfigjson,
                                    decodedData: [".dockerconfigjson": #"{"auths":{}}"#])
        let copy = original.copied(toNamespace: "media")
        XCTAssertEqual(copy.metadata.namespace, "media")
        XCTAssertEqual(copy.metadata.name, "regcred")
        XCTAssertEqual(copy.metadata.uid, "")          // server metadata dropped
        XCTAssertEqual(copy.data, original.data)        // base64 payload preserved verbatim
        XCTAssertTrue(copy.toYAML().contains("namespace: 'media'"))
    }

    func test_secretCopied_dropsRealServerMetadata() {
        // Build a Secret as if returned by `kubectl get -o json` — with server fields populated.
        let meta = ObjectMeta(
            name: "regcred",
            namespace: "default",
            uid: "server-uid-123",
            creationTimestamp: Date(timeIntervalSince1970: 1577836800), // 2020-01-01T00:00:00Z
            labels: ["app": "x"],
            annotations: ["kubectl.kubernetes.io/last-applied-configuration": "{...}"]
        )
        let original = Secret(metadata: meta, type: "kubernetes.io/dockerconfigjson", data: [".dockerconfigjson": "e30="])
        let copy = original.copied(toNamespace: "media")
        XCTAssertEqual(copy.metadata.namespace, "media")
        XCTAssertEqual(copy.metadata.uid, "")
        XCTAssertNil(copy.metadata.creationTimestamp)
        XCTAssertNil(copy.metadata.annotations)
        XCTAssertEqual(copy.metadata.labels, ["app": "x"])              // labels preserved
        XCTAssertEqual(copy.data, [".dockerconfigjson": "e30="])        // data preserved verbatim
        XCTAssertEqual(copy.type, "kubernetes.io/dockerconfigjson")
    }

    func test_secretCopied_outputNeverContainsResourceVersion() throws {
        // A server-returned Secret JSON carrying resourceVersion (a field ObjectMeta
        // doesn't model, so it's dropped on decode). The copy's YAML must not carry it,
        // or `kubectl apply` would conflict-fail. Guards against a future ObjectMeta
        // gaining resourceVersion and silently breaking the copy path.
        let json = """
        {"apiVersion":"v1","kind":"Secret","type":"kubernetes.io/dockerconfigjson",
         "metadata":{"name":"regcred","namespace":"default","uid":"abc","resourceVersion":"998877","creationTimestamp":"2020-01-01T00:00:00Z"},
         "data":{".dockerconfigjson":"e30="}}
        """
        let src = try JSONDecoder.kube.decode(Secret.self, from: Data(json.utf8))
        let yaml = src.copied(toNamespace: "media").toYAML()
        XCTAssertFalse(yaml.contains("resourceVersion"))
        XCTAssertFalse(yaml.contains("998877"))
        XCTAssertTrue(yaml.contains("namespace: 'media'"))
    }
}
