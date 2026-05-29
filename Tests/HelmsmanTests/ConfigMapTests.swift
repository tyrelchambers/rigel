import XCTest
import Yams
@testable import Helmsman

final class ConfigMapTests: XCTestCase {
    private func draft(
        data: [String: String] = ["KEY": "value"],
        binaryData: [String: String]? = nil
    ) -> ConfigMap {
        ConfigMap.draft(name: "cfg", namespace: "default", data: data, binaryData: binaryData)
    }

    func test_draft_toYAML_basic() {
        let yaml = draft().toYAML()
        XCTAssertTrue(yaml.contains("apiVersion: v1"))
        XCTAssertTrue(yaml.contains("kind: ConfigMap"))
        XCTAssertTrue(yaml.contains("name: cfg"))
        XCTAssertTrue(yaml.contains("namespace: default"))
        XCTAssertTrue(yaml.contains("KEY: value"))
    }

    func test_draft_emptyData_omitsDataBlock() {
        let yaml = draft(data: [:]).toYAML()
        XCTAssertNil(draft(data: [:]).data)
        XCTAssertFalse(yaml.contains("\ndata:"))
    }

    func test_toYAML_multilineValue_roundTripsViaYams() throws {
        // ConfigMaps commonly hold whole config files — the serialized YAML must
        // parse back to the exact multi-line string (block scalar handling).
        let conf = "server {\n  listen 80;\n  root /var/www;\n}\n"
        let yaml = draft(data: ["nginx.conf": conf]).toYAML()
        let parsed = try Yams.load(yaml: yaml) as? [String: Any]
        let data = parsed?["data"] as? [String: String]
        XCTAssertEqual(data?["nginx.conf"], conf)
    }

    func test_draft_preservesBinaryData() {
        let cm = draft(data: ["a": "1"], binaryData: ["blob": "AAAA"])
        XCTAssertEqual(cm.binaryData?["blob"], "AAAA")
        XCTAssertTrue(cm.toYAML().contains("binaryData:"))
    }

    func test_keysSorted_mergesDataAndBinary() {
        let cm = draft(data: ["b": "1", "a": "1"], binaryData: ["c": "AAAA"])
        XCTAssertEqual(cm.keysSorted, ["a", "b", "c"])
        XCTAssertEqual(cm.keyCount, 3)
    }

    func test_editableAnnotations_dropsLastApplied() {
        let meta = ObjectMeta(
            name: "cfg", namespace: "default", uid: "u1", creationTimestamp: nil,
            labels: nil,
            annotations: [
                "kubectl.kubernetes.io/last-applied-configuration": "{...}",
                "keep": "yes",
            ]
        )
        let cm = ConfigMap(metadata: meta, data: nil, binaryData: nil)
        XCTAssertEqual(cm.editableAnnotations, ["keep": "yes"])
    }

    // MARK: - WorkloadAction

    func test_applyConfigMap_isApplyYAML_andLowRisk() {
        let action = WorkloadAction.applyConfigMap(draft(), isNew: false)
        let invs = action.kubectlInvocations()
        XCTAssertEqual(invs.count, 1)
        XCTAssertEqual(invs[0].args, ["apply", "-f", "-"])
        XCTAssertNotNil(invs[0].stdin)
        XCTAssertFalse(action.isHighRisk)
        XCTAssertFalse(action.needsAcknowledge)
    }

    func test_applyConfigMap_titleReflectsIsNew() {
        XCTAssertTrue(WorkloadAction.applyConfigMap(draft(), isNew: true).title.contains("Create"))
        XCTAssertTrue(WorkloadAction.applyConfigMap(draft(), isNew: false).title.contains("Apply"))
    }

    func test_deleteConfigMap_invocationAndRisk() {
        let action = WorkloadAction.deleteConfigMap(name: "cfg", namespace: "default")
        XCTAssertEqual(action.kubectlInvocations(), [.args(["delete", "configmap", "cfg", "-n", "default"])])
        XCTAssertTrue(action.isHighRisk)
        XCTAssertTrue(action.needsAcknowledge)
    }
}
