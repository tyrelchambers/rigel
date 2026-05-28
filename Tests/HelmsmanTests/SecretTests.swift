import XCTest
@testable import Helmsman

final class SecretTests: XCTestCase {
    func test_secretType_initFromRaw() {
        XCTAssertEqual(SecretType(rawType: nil), .opaque)
        XCTAssertEqual(SecretType(rawType: ""), .opaque)
        XCTAssertEqual(SecretType(rawType: "Opaque"), .opaque)
        XCTAssertEqual(SecretType(rawType: "kubernetes.io/dockerconfigjson"), .dockerconfigjson)
        XCTAssertEqual(SecretType(rawType: "kubernetes.io/tls"), .tls)
        XCTAssertEqual(SecretType(rawType: "bootstrap.kubernetes.io/token"), .other)
    }

    func test_decodedHelper_roundTripsUTF8() {
        let s = Secret.draft(
            name: "demo",
            namespace: "default",
            type: .opaque,
            decodedData: ["foo": "bar baz", "with-quote": "it's fine"]
        )
        XCTAssertEqual(s.decoded("foo"), "bar baz")
        XCTAssertEqual(s.decoded("with-quote"), "it's fine")
        XCTAssertNil(s.decoded("missing"))
    }

    func test_toYAML_opaque_includesNamespaceTypeAndBase64Data() {
        let s = Secret.draft(
            name: "test",
            namespace: "default",
            type: .opaque,
            decodedData: ["key1": "value1"]
        )
        let yaml = s.toYAML()
        XCTAssertTrue(yaml.contains("apiVersion: v1"))
        XCTAssertTrue(yaml.contains("kind: Secret"))
        XCTAssertTrue(yaml.contains("name: 'test'"))
        XCTAssertTrue(yaml.contains("namespace: 'default'"))
        XCTAssertTrue(yaml.contains("type: 'Opaque'"))
        // "value1" → base64 "dmFsdWUx"
        XCTAssertTrue(yaml.contains("'key1': 'dmFsdWUx'"))
    }

    func test_toYAML_dockerconfigjson_emitsCorrectType() {
        let s = Secret.draft(
            name: "ghrc",
            namespace: "default",
            type: .dockerconfigjson,
            decodedData: [".dockerconfigjson": #"{"auths":{}}"#]
        )
        let yaml = s.toYAML()
        XCTAssertTrue(yaml.contains("type: 'kubernetes.io/dockerconfigjson'"))
        XCTAssertTrue(yaml.contains("'.dockerconfigjson':"))
    }

    func test_toYAML_singleQuoteEscaping() {
        // YAML single-quote escape rule: doubled single quotes inside.
        let escaped = Secret.yamlScalar("can't stop")
        XCTAssertEqual(escaped, "'can''t stop'")
    }

    func test_moveSecret_skipNoopWhenUnchanged() {
        let s = Secret.draft(name: "x", namespace: "default", type: .opaque, decodedData: ["k": "v"])
        let action = WorkloadAction.moveSecret(original: s, newName: "x", newNamespace: "default")
        XCTAssertTrue(action.kubectlInvocations().isEmpty)
    }

    func test_moveSecret_emitsApplyThenDeleteWhenChanged() {
        let s = Secret.draft(name: "x", namespace: "default", type: .opaque, decodedData: ["k": "v"])
        let action = WorkloadAction.moveSecret(original: s, newName: "y", newNamespace: "kube-system")
        let invs = action.kubectlInvocations()
        XCTAssertEqual(invs.count, 2)
        XCTAssertEqual(invs[0].args, ["apply", "-f", "-"])
        XCTAssertNotNil(invs[0].stdin)
        if let yaml = invs[0].stdin.flatMap({ String(data: $0, encoding: .utf8) }) {
            XCTAssertTrue(yaml.contains("name: 'y'"))
            XCTAssertTrue(yaml.contains("namespace: 'kube-system'"))
        }
        XCTAssertEqual(invs[1].args, ["delete", "secret", "x", "-n", "default"])
        XCTAssertNil(invs[1].stdin)
    }

    func test_applySecret_emitsApplyDashF() {
        let s = Secret.draft(name: "x", namespace: "default", type: .opaque, decodedData: ["k": "v"])
        let action = WorkloadAction.applySecret(s)
        let invs = action.kubectlInvocations()
        XCTAssertEqual(invs.count, 1)
        XCTAssertEqual(invs[0].args, ["apply", "-f", "-"])
        XCTAssertNotNil(invs[0].stdin)
    }

    func test_deleteSecret_singleInvocation() {
        let action = WorkloadAction.deleteSecret(name: "x", namespace: "default")
        let invs = action.kubectlInvocations()
        XCTAssertEqual(invs.count, 1)
        XCTAssertEqual(invs[0].args, ["delete", "secret", "x", "-n", "default"])
        XCTAssertTrue(action.needsAcknowledge)
    }

    func test_toYAML_skipsServerManagedAndAnnotations() {
        // Even if labels/annotations exist on a draft, drafts have annotations=nil.
        let s = Secret.draft(
            name: "x",
            namespace: "default",
            type: .opaque,
            decodedData: ["k": "v"],
            labels: ["app": "x"]
        )
        let yaml = s.toYAML()
        XCTAssertTrue(yaml.contains("labels:"))
        XCTAssertTrue(yaml.contains("'app': 'x'"))
        XCTAssertFalse(yaml.contains("annotations:"))
        XCTAssertFalse(yaml.contains("uid:"))
        XCTAssertFalse(yaml.contains("creationTimestamp:"))
    }
}
